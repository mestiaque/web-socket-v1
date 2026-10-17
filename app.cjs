// CommonJS entry point for process managers that load the startup file with
// require(), such as Phusion Passenger in cPanel "Setup Node.js App".
// It simply loads the ES module server.
import('./src/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
