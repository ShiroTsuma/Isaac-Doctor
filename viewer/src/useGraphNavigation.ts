import {useEffect,useRef} from 'react';
import type {KeyboardEvent,PointerEvent,RefObject} from 'react';
interface Drag {x:number;width:number;range:[number,number];shift:boolean;moved:boolean}
export default function useGraphNavigation<T extends HTMLElement|SVGSVGElement>({element,range,duration,setRange,onClick}:{element:RefObject<T|null>;range:[number,number];duration:number;setRange:(range:[number,number])=>void;onClick?:(e:PointerEvent<T>)=>void}){
  const drag=useRef<Drag|null>(null);
  useEffect(()=>{const el=element.current;if(!el || !duration)return;function wheel(event:Event){if(!(event instanceof WheelEvent))return;const e=event;e.preventDefault();const bounds=el!.getBoundingClientRect(),span=range[1]-range[0];if(e.shiftKey && !e.ctrlKey){const delta=span*(Math.sign(e.deltaY || e.deltaX)*.1);setRange([range[0]+delta,range[1]+delta]);}else{const ratio=Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width)),anchor=range[0]+ratio*span,next=span*(e.deltaY>0?1.25:.8);setRange([anchor-ratio*next,anchor+(1-ratio)*next]);}}el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[element,range,duration,setRange]);
  return {
    onPointerDown(e:PointerEvent<T>){if(!duration || e.button!==0)return;const bounds=e.currentTarget.getBoundingClientRect();drag.current={x:e.clientX-bounds.left,width:bounds.width,range:[...range],shift:e.shiftKey,moved:false};e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);},
    onPointerMove(e:PointerEvent<T>){const d=drag.current;if(!d)return;const x=e.clientX-e.currentTarget.getBoundingClientRect().left;if(Math.abs(x-d.x)>=4)d.moved=true;if(!d.moved)return;const scale=(d.range[1]-d.range[0])/d.width;if(d.shift){const a=d.range[0]+d.x*scale,b=d.range[0]+x*scale;setRange([Math.min(a,b),Math.max(a,b)]);}else{const delta=(x-d.x)*scale;setRange([d.range[0]-delta,d.range[1]-delta]);}},
    onPointerUp(e:PointerEvent<T>){const d=drag.current;drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);if(d && !d.moved)onClick?.(e);},
    onPointerCancel(){drag.current=null;},
    onKeyDown(e:KeyboardEvent<T>){const span=range[1]-range[0],center=(range[0]+range[1])/2;let next:[number,number]|undefined;if(['+','=','w','W'].includes(e.key))next=[center-span*.25,center+span*.25];else if(['-','s','S'].includes(e.key))next=[center-span,center+span];else if(['ArrowLeft','a','A'].includes(e.key))next=[range[0]-span*.15,range[1]-span*.15];else if(['ArrowRight','d','D'].includes(e.key))next=[range[0]+span*.15,range[1]+span*.15];else if(e.key==='Home')next=[0,duration];if(next){e.preventDefault();setRange(next);}},
  };
}
