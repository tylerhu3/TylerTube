// OS dispatcher for the public deploy: `npm run deploy:public [-- --dry-run] [-- --skip-build]`
// Automatically runs scripts/deploy-public.win.mjs on Windows or scripts/deploy-public.mac.mjs on macOS/Unix.
const argv = process.argv.slice(2);

try {
  if (process.platform === "win32") {
    const { deployWin } = await import("./deploy-public.win.mjs");
    await deployWin(argv);
  } else {
    const { deployMac } = await import("./deploy-public.mac.mjs");
    await deployMac(argv);
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
