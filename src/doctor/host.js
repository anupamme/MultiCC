'use strict';
// Composition for the session doctor: wires the Aux HTTP target and the host's
// session/history accessors into the service and mounts its routes.
const os = require('os');
const path = require('path');
const { createDoctorService } = require('./service');
const { mountDoctorRoutes } = require('../routes/doctor');

function mountDoctor(app, { persistedSessions, loadChatHistory, cwdForSession, auxQueue, getAuxConfig, rootDir, dataDir }) {
  const doctor = createDoctorService({
    getSession: id => persistedSessions.get(id),
    loadHistory: loadChatHistory,
    cwdOf: cwdForSession,
    resolveTarget: () => {
      const target = auxQueue.resolveHttpTarget();
      return { target, model: getAuxConfig().model || target.model || (target.modelOptions || [])[0] || '' };
    },
    repoRoot: rootDir,
    dataDir,
    logDirs: [path.join(rootDir, 'logs'), path.join(os.homedir(), '.pm2', 'logs')],
    serverPid: process.pid,
  });
  mountDoctorRoutes(app, { doctor });
  return doctor;
}

module.exports = { mountDoctor };
