import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'store.adityastudio.app',
  appName: 'Aditya Studio',
  webDir: 'www',
  server: {
    url: 'https://www.adityastudio.store',
    cleartext: false,
    allowNavigation: ['adityastudio.store', 'www.adityastudio.store']
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
