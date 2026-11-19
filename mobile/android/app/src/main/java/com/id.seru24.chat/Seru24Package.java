package id.seru24.chat;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Modul native seru24 (scrypt, notifikasi, penyimpanan chat lokal, pembaruan aplikasi, dokumen); didaftarkan manual di MainApplication. */
public class Seru24Package implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext context) {
        return Arrays.asList(new ScryptModule(context), new NotifyModule(context), new ChatStoreModule(context), new UpdateModule(context),
            new FileModule(context), new AudioModule(context), new NearbyModule(context));
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext context) {
        return Collections.emptyList();
    }
}
