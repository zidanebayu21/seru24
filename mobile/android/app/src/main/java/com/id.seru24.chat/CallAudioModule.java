package id.seru24.chat;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * Jalur audio telepon suara: mode komunikasi (suara keluar lewat earpiece) dan tombol speaker (loudspeaker).
 * react-native-webrtc hanya memutar audio lawan; pemilihan perangkat keluarnya diatur di sini lewat AudioManager.
 */
public class CallAudioModule extends ReactContextBaseJavaModule {
    CallAudioModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "Seru24CallAudio";
    }

    private AudioManager audio() {
        return (AudioManager) getReactApplicationContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /** Panggilan dimulai: pakai mode komunikasi dengan earpiece sebagai tujuan awal. */
    @ReactMethod
    public void begin() {
        AudioManager manager = audio();
        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        routeToSpeaker(manager, false);
    }

    @ReactMethod
    public void setSpeaker(boolean on) {
        routeToSpeaker(audio(), on);
    }

    /** Panggilan selesai: kembalikan mode audio normal. */
    @ReactMethod
    public void end() {
        AudioManager manager = audio();
        routeToSpeaker(manager, false);
        manager.setMode(AudioManager.MODE_NORMAL);
    }

    private void routeToSpeaker(AudioManager manager, boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!on) {
                manager.clearCommunicationDevice();
                return;
            }
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    manager.setCommunicationDevice(device);
                    return;
                }
            }
        } else {
            manager.setSpeakerphoneOn(on);
        }
    }
}
