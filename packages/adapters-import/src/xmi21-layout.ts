export function gridLayout(classes: Array<{ id: string; x: number; y: number }>, spacing = 150): void {
  const cols = Math.ceil(Math.sqrt(classes.length));
  classes.forEach((cls, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    cls.x = col * spacing + 100;
    cls.y = row * spacing + 100;
  });
}

export function centerNaryDiamond(nary: { memberEnds: Array<{ classId: string }>; x: number; y: number }, classPositions: Map<string, { x: number; y: number }>): void {
  const positions = nary.memberEnds.map(end => classPositions.get(end.classId)).filter(p => p !== undefined);
  if (positions.length === 0) {
    nary.x = 0;
    nary.y = 0;
    return;
  }
  const sumX = positions.reduce((s, p) => s + p.x, 0);
  const sumY = positions.reduce((s, p) => s + p.y, 0);
  nary.x = sumX / positions.length;
  nary.y = sumY / positions.length;
}