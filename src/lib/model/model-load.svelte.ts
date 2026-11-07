import { loadModel } from './model.js';

let failed = $state(false);

export function modelLoadFailed(): boolean {
  return failed;
}

export async function loadModelForApp(): Promise<void> {
  try {
    await loadModel();
    failed = false;
  } catch (error) {
    failed = true;
    throw error;
  }
}
