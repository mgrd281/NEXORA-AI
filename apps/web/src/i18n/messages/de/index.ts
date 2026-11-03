import type { Messages } from '../../catalog';
import admin from './admin';
import approvals from './approvals';
import auth from './auth';
import common from './common';
import composer from './composer';
import connections from './connections';
import errors from './errors';
import home from './home';
import memory from './memory';
import notifications from './notifications';
import settings from './settings';
import shell from './shell';
import tasks from './tasks';
import voice from './voice';

const de: Messages = {
  common,
  shell,
  auth,
  composer,
  voice,
  approvals,
  tasks,
  home,
  memory,
  connections,
  settings,
  admin,
  notifications,
  errors,
};

export default de;
