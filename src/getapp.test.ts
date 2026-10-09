import { describe, expect, it } from 'vitest';
import { appOffer, latestInstaller } from './getapp';

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 15; CPH2611) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 16181.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

describe('app offer', () => {
  it('offers the app for the visitor’s computer', () => {
    expect(appOffer(UA.windows)).toBe('windows');
    expect(appOffer(UA.mac)).toBe('mac');
    expect(appOffer(UA.linux)).toBe('linux');
  });

  it('offers the Android app on Android', () => {
    expect(appOffer(UA.android)).toBe('android');
  });

  it('offers nothing on iPhones, iPads and Chromebooks', () => {
    expect(appOffer(UA.iphone)).toBeNull();
    expect(appOffer(UA.mac, 5)).toBeNull(); // an iPad asking for the desktop site
    expect(appOffer(UA.chromebook)).toBeNull();
  });

  const release = {
    tag_name: 'desktop-v0.19.2',
    assets: [
      'latest.json', 'My.Own.AI_0.19.2_aarch64.dmg', 'My.Own.AI_0.19.2_amd64.AppImage', 'My.Own.AI_0.19.2_amd64.AppImage.sig',
      'My.Own.AI_0.19.2_amd64.deb', 'My.Own.AI_0.19.2_android.apk', 'My.Own.AI_0.19.2_x64-setup.exe', 'My.Own.AI_0.19.2_x64-setup.exe.sig', 'My.Own.AI_aarch64.app.tar.gz',
    ].map((name, i) => ({ name, browser_download_url: `https://github.com/x/releases/download/desktop-v0.19.2/${name}`, size: i * 1000 })),
  };
  const fakeFetch = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('finds the installer in the latest release', async () => {
    expect(await latestInstaller('windows', fakeFetch(release))).toMatchObject({ name: 'My.Own.AI_0.19.2_x64-setup.exe', version: '0.19.2', bytes: 6000 });
    expect((await latestInstaller('mac', fakeFetch(release)))?.name).toBe('My.Own.AI_0.19.2_aarch64.dmg');
    expect((await latestInstaller('linux', fakeFetch(release)))?.name).toBe('My.Own.AI_0.19.2_amd64.AppImage');
    expect((await latestInstaller('android', fakeFetch(release)))?.name).toBe('My.Own.AI_0.19.2_android.apk');
  });

  it('gives up quietly when GitHub fails', async () => {
    expect(await latestInstaller('windows', fakeFetch({}, false))).toBeNull();
    expect(await latestInstaller('windows', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
    expect(await latestInstaller('windows', fakeFetch({ assets: [] }))).toBeNull();
  });
});
