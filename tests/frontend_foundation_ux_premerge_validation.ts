import assert from "node:assert/strict";
import { parseQuantityInput, isPositiveIntegerText } from "../web/src/quantityInput.js";
import { ScrollMemory, type ScrollDeps } from "../web/src/scrollRestoration.js";
for(const raw of ["", "0", "-1", "1.5", "1e2", "2 units", "99999999999999999", "21"]) {
  assert.equal(parseQuantityInput(raw,1,20).value,null,`must not coerce ${raw}`);
}
for(const [raw,value] of [["1",1],["20",20],["007",7],[" 2 ",2]] as const) {
  assert.equal(parseQuantityInput(raw,1,20).value,value);
}
for(const raw of ["", "0", "1.5", "-1", "1e2"]) assert.equal(isPositiveIntegerText(raw),false);
console.log("PASS quantity boundaries, paste, empty and invalid input preserve intended integers");

let state: unknown = null, y = 0, time = 0;
const frames: (() => void)[] = [];
const deps: ScrollDeps = {
  readState:()=>state, replaceState:value=>{state=value;}, scrollY:()=>y,
  scrollTo:value=>{y=value;}, scrollHeight:()=>3000, innerHeight:()=>844,
  now:()=>time, requestFrame:cb=>frames.push(cb), readStore:()=>null,
  writeStore:()=>undefined, newKey:()=>"test-entry"
};
const memory = new ScrollMemory(deps);
memory.boot();memory.restore(250);
y=282;time+=16;frames.shift()?.();
assert.equal(y,250,"async layout shift must not lose the saved history position");
memory.cancelRestore();y=310;time+=16;frames.shift()?.();
assert.equal(y,310,"explicit user input must take over immediately");
console.log("PASS history restoration absorbs async layout shifts and yields to user input");
