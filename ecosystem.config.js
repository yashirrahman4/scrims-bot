module.exports = {
  apps: [
    {
      name: 'scrims-bot',
      script: 'src/index.js',
      node_args: '-r ./src/proxy-shim.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
