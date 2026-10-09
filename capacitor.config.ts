import type { CapacitorConfig } from '@capacitor/cli';

// The Android app: the same web build (dist/) in a native WebView.
const config: CapacitorConfig = {
  appId: 'ai.local.assistant',
  appName: 'My Own AI',
  webDir: 'dist',
  android: {
    // Served as https://localhost: a secure context, which WebGPU requires.
    // (androidScheme defaults to https in Capacitor 6+.)
    webContentsDebuggingEnabled: true,
  },
};

export default config;
