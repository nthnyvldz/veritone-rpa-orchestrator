module.exports = {
  apps: [{
    name: 'veritone-rpa-orchestrator',
    script: 'dist/src/orchestrator.js',
    restart_delay: 5000,
    max_restarts: 5,
    autorestart: true,
  }]
};
