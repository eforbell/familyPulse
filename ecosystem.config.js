module.exports = {
  apps: [{
    name: 'family-pulse',
    script: 'server.js',
    cwd: '/data/apps/familyPulse',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
