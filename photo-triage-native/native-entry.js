import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { PhotoLibrary } from "@capgo/capacitor-photo-library";

const PhotoDeleter = registerPlugin("PhotoDeleter");

window.PhotoSiftNative = {
  Capacitor,
  App,
  PhotoLibrary,
  PhotoDeleter,
  isNative: Capacitor.isNativePlatform()
};
