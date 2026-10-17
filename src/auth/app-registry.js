/**
 * Read-only lookup of configured applications and their signing keys.
 * Each application has its own key set, so credentials never cross apps.
 * Multiple keys per app allow zero-downtime rotation (see docs/SECURITY.md).
 */
export class AppRegistry {
  /** @param {ReadonlyArray<{id: string, keys: ReadonlyArray<{id: string, secret: Buffer}>}>} apps */
  constructor(apps) {
    this.apps = new Map();
    for (const app of apps) {
      this.apps.set(app.id, { app, keys: new Map(app.keys.map((k) => [k.id, k.secret])) });
    }
  }

  get(appId) {
    if (typeof appId !== 'string') return undefined;
    return this.apps.get(appId)?.app;
  }

  /** @returns {Buffer | undefined} */
  getSecret(appId, keyId) {
    if (typeof appId !== 'string' || typeof keyId !== 'string') return undefined;
    return this.apps.get(appId)?.keys.get(keyId);
  }

  ids() {
    return [...this.apps.keys()];
  }
}
