export class Superseded extends Error {constructor(){super('Request superseded by a newer view.');}}
export async function yieldTask(){const scheduler=(globalThis as typeof globalThis & {scheduler?:{yield:()=>Promise<void>}}).scheduler;if(scheduler)await scheduler.yield();else await new Promise<void>(resolve=>setTimeout(resolve,0));}
