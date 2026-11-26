// Preserve DOM order within each named checkbox group.
// This is identity metadata only: never read or change values.
export function addCheckboxOrdinals30W(controls) {
  if (!Array.isArray(controls)) return controls;

  const groupPositions=new Map();

  for(const control of controls) {
    if(
      control?.type!=="checkbox" ||
      typeof control.name!=="string" ||
      !control.name.trim()
    ) continue;

    const group=control.name.trim().toLowerCase();
    const ordinal=(groupPositions.get(group)??0)+1;

    groupPositions.set(group,ordinal);
    control.ordinal=ordinal;
  }

  return controls;
}
