# Odometry Scope desktop

An Electron shell around the web app. It loads `apps/web` and adds a native menu,
external-link handling, and single-instance locking.

```bash
npm run dev --workspace @odometryscope/desktop     # requires apps/web running on :3000
npm run dist --workspace @odometryscope/desktop    # installers into dist/
```

Set `PRODUCT_WEB_URL` to point the shell at a deployed build instead of localhost.
