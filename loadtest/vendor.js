// Tiny helpers kept local, so the load test has no remote imports.
export function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}
