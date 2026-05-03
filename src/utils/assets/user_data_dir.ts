import path from 'path';
import os from 'os';

export const userDataDir = path.join(
  os.homedir(), '.config', 'google-chrome', 'Profile 3'
);