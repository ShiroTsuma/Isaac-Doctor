export interface Timed {minimum:number;maximum:number}
// Balanced interval tree: starts are sorted; subtree maxima preserve long overlaps.
export class TimeIndex<T extends Timed>{
  readonly items:T[];readonly ends:Float64Array;readonly size:number;
  constructor(items:T[]){this.items=items.slice().sort((a,b)=>a.minimum-b.minimum);let n=1;while(n<items.length)n*=2;this.size=n;this.ends=new Float64Array(n*2);this.ends.fill(-Infinity);for(let i=0;i<this.items.length;i++)this.ends[n+i]=this.items[i].maximum;for(let i=n-1;i;i--)this.ends[i]=Math.max(this.ends[i*2],this.ends[i*2+1]);}
  query(start:number,end:number):T[]{const result:T[]=[];const visit=(node:number,left:number,right:number)=>{if(left>=this.items.length || this.ends[node]<start || this.items[left].minimum>end)return;if(right-left===1){result.push(this.items[left]);return;}const middle=(left+right)>>>1;visit(node*2,left,middle);visit(node*2+1,middle,right);};visit(1,0,this.size);return result;}
}
