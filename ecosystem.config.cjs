module.exports = {
  apps: [
    {
      name: "fish-ims",
      script: "server/server.js",
      cwd: __dirname,
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        API_PORT: "3001",
      },
    },
  ],
};
