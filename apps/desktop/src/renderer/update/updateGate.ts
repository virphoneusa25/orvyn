let required = false;

export function setRequiredDesktopUpdate(value: boolean): void {
  required = value === true;
}

export function requiredUpdateBlocksCloudSubmit(): boolean {
  return required;
}
