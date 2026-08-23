import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: process.env.SITON_APP_ID || "il.co.siton.preview",
  appName: "Siton",
  webDir: ".mobile_dist",
  server: {
    androidScheme: "https",
    cleartext: false,
    allowNavigation: [],
    appStartPath: "/app",
    errorPath: "app/offline.html"
  },
  android: {
    allowMixedContent: false,
    captureInput: true
  },
  ios: {
    scheme: "Siton",
    contentInset: "automatic"
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    CapacitorCookies: {
      enabled: true
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"]
    }
  }
};

export default config;
