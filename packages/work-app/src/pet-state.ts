export interface PetTask {
  id: string; title: string; status: string; updatedAt: string;
  plan?: { done: number; total: number };
}
/** 等待人工优先；终态只短暂展示，避免启动时庆祝陈旧历史。 */
export function selectPetTask(tasks: readonly PetTask[], now = Date.now()): PetTask {
  const waiting = tasks.filter(t => t.status === 'waiting').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt));
  const active = waiting[0] ?? tasks.find(t => t.status === 'running');
  if (active) return active;
  return [...tasks].filter(t => ['completed','failed','cancelled'].includes(t.status) && now - Date.parse(t.updatedAt) >= 0 && now - Date.parse(t.updatedAt) < 12000)
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? {id:'',title:'',status:'idle',updatedAt:''};
}
