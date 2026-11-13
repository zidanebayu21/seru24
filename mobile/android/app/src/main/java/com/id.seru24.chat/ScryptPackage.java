package id.seru24.chat;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Collections;
import java.util.List;

/** Mendaftarkan ScryptModule ke React Native (didaftarkan manual di MainApplication). */
public class ScryptPackage implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext context) {
        return Collections.singletonList(new ScryptModule(context));
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext context) {
        return Collections.emptyList();
    }
}
