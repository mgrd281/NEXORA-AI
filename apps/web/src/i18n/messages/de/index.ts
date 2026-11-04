import type { Messages } from '../../catalog';
import admin from './admin';
import approvals from './approvals';
import attachments from './attachments';
import auth from './auth';
import common from './common';
import composer from './composer';
import connections from './connections';
import conversations from './conversations';
import errors from './errors';
import home from './home';
import memory from './memory';
import notifications from './notifications';
import schedules from './schedules';
import settings from './settings';
import shell from './shell';
import skills from './skills';
import tasks from './tasks';
import voice from './voice';
import webhooks from './webhooks';

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
  conversations,
  attachments,
  schedules,
  skills,
  webhooks,
};

export default de;
