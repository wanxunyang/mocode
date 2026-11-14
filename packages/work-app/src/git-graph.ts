/**
 * Git 提交泳道图的行级布局：纯计算，无 IO、无 DOM。
 *
 * 输入是按 `--date-order` 排好的提交（git 保证父提交永远排在子提交之后），
 * 输出每一行要画什么：节点落在哪个 lane、哪些 lane 直通、节点连向哪些父提交。
 *
 * 状态机可以一句话概括 —— 每个 lane 表示「这一列正在等哪个提交」：
 *   · 遇到提交 C：找哪条 lane 在等 C。找到就是它的 lane（说明有子提交已经把它连下来了）；
 *     找不到就占一个空位 / 新开一列 —— 分支尖端就属于后者。
 *   · C 的第一父提交优先占住 C 自己的 lane（同一条分支继续往下，颜色不变）；
 *     其余父提交若已有 lane 在等它，就并过去（画一条斜线）；否则另开一列。
 *   · 于是**任何非节点 lane 都不会半路消失**：它要么等到自己的提交、成为节点，
 *     要么正是在那次并线里结束。所以渲染侧只需处理三件事：直通线、节点、斜线。
 *
 * 为什么要把这个算法单独拎出来：它是这次「历史视图」里唯一有真逻辑的部分
 * （分支/合并/汇合/pagination 续算），放在渲染层里既难测也容易被 DOM 细节淹没。
 *
 * walker 可跨页续算：分页拉取时把状态留在内存，第二页的行从第一页结束处接着画。
 */

export interface CommitNode {
  sha: string;
  parents: readonly string[];
}

export interface LaneRef {
  lane: number;
  /** 调色板序号，渲染侧映射成 .lane-N 类（配色留在 CSS 里，跟随主题） */
  color: number;
}

export interface GraphEdge {
  /** 起点 lane（本行节点所在列） */
  from: number;
  /** 终点 lane（父提交落在哪一列） */
  to: number;
  /** 沿用节点所在分支的颜色 */
  color: number;
}

export interface GraphRow {
  sha: string;
  lane: number;
  color: number;
  /** 贯穿整行的竖直连线（不含节点自己那一列） */
  through: LaneRef[];
  /** 行顶是否存在连到节点的线（有 lane 在等这个提交 → true） */
  fromTop: boolean;
  /** 节点 → 各父提交的连线 */
  edges: GraphEdge[];
  /** 本行涉及的 lane 总数，渲染侧据此算图宽 */
  lanes: number;
}

export interface GraphState {
  lanes: Array<string | null>;
  colors: number[];
  nextColor: number;
}

/** 调色板长度；必须与 style.css 里定义的 .lane-0 … .lane-N 数量一致。 */
export const LANE_PALETTE_SIZE = 8;

export class GraphWalker {
  private lanes: Array<string | null> = [];
  private colors: number[] = [];
  private nextColor = 0;

  constructor(state?: GraphState) {
    if (!state) return;
    this.lanes = [...state.lanes];
    this.colors = [...state.colors];
    this.nextColor = state.nextColor;
  }

  /** 当前状态快照（分页续算 / 重绘后接着画用）。 */
  get state(): GraphState {
    return { lanes: [...this.lanes], colors: [...this.colors], nextColor: this.nextColor };
  }

  /** 还有多少条分支在等后续提交（= 图底部仍存活的线数）。 */
  get activeLanes(): number {
    return this.lanes.filter((lane) => lane !== null).length;
  }

  /** 处理一个提交，返回它那一行的布局。 */
  push(commit: CommitNode): GraphRow {
    const beforeLanes = this.lanes.slice();
    const beforeColors = this.colors.slice();

    let lane = this.lanes.indexOf(commit.sha);
    const fromTop = lane >= 0;
    if (lane < 0) lane = this.allocSlot();
    // allocSlot 把复用到的空位标成 -1（表示「上一任的颜色已失效」），所以这里必须用
    // `< 0` 判空 —— 用 `??` 会把 -1 当成有效颜色，渲染层拿到不存在的 lane--1。
    const color = (this.colors[lane] ?? -1) < 0 ? this.takeColor() : this.colors[lane];
    this.colors[lane] = color;
    // 先把自己从「等待表」里摘掉：同一个 slot 随后可能被第一父提交立刻占回去。
    this.lanes[lane] = null;

    const edges: GraphEdge[] = [];
    for (const parent of commit.parents) {
      let target = this.lanes.indexOf(parent);
      if (target < 0) {
        // 第一父提交延续本条分支的 lane 与颜色；后续父提交占空位或新开一列。
        target = edges.length === 0 ? lane : this.allocSlot();
        this.lanes[target] = parent;
        this.colors[target] = target === lane ? color : this.takeColor();
      }
      edges.push({ from: lane, to: target, color });
    }
    this.trim();

    // 直通线 = 本行前后都还活着、且不是节点自己那一列。
    const through: LaneRef[] = [];
    for (let i = 0; i < beforeLanes.length; i++) {
      if (i === lane || beforeLanes[i] === null) continue;
      if (this.lanes[i] !== null) through.push({ lane: i, color: beforeColors[i] ?? 0 });
    }

    return {
      sha: commit.sha,
      lane,
      color,
      through,
      fromTop,
      edges,
      lanes: Math.max(beforeLanes.length, this.lanes.length, lane + 1),
    };
  }

  /** 空位复用优先，没有空位才加宽 —— 否则反复分叉合并会让图越画越宽。 */
  private allocSlot(): number {
    const free = this.lanes.indexOf(null);
    if (free >= 0) {
      // 新占用这个 slot 的分支要拿新颜色，不能沿用上一任的。
      this.colors[free] = -1;
      return free;
    }
    this.lanes.push(null);
    this.colors.push(-1);
    return this.lanes.length - 1;
  }

  private takeColor(): number {
    const color = this.nextColor % LANE_PALETTE_SIZE;
    this.nextColor += 1;
    return color;
  }

  /** 去掉尾部空 lane：合并后的历史若不再分叉，图宽应当立刻收窄。 */
  private trim(): void {
    while (this.lanes.length && this.lanes[this.lanes.length - 1] === null) {
      this.lanes.pop();
      this.colors.pop();
    }
  }
}

/** 一次性把一串提交算成行（不分页时的入口）。 */
export function buildGraph(commits: readonly CommitNode[]): GraphRow[] {
  const walker = new GraphWalker();
  return commits.map((commit) => walker.push(commit));
}