package id.seru24.chat.rust;

import android.Manifest;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Jalur audio panggilan (`AudioManager`) dan WebRTC suara 1-ke-1 (`org.webrtc`).
 * SDP dan ICE hanya lewat Sinyal E2EE; server TURN/STUN default sama seperti `call-core.ts`.
 */
final class Seru24CallWebRtc {
    private static PeerConnectionFactory factory;
    private static PeerConnection peer;
    private static AudioSource audioSource;
    private static AudioTrack audioTrack;
    private static boolean initialized;

    private Seru24CallWebRtc() {}

    static void audioBegin(Context context) {
        AudioManager mgr = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (mgr == null) return;
        mgr.setMode(AudioManager.MODE_IN_COMMUNICATION);
        routeSpeaker(mgr, false);
    }

    static void audioSpeaker(Context context, boolean on) {
        AudioManager mgr = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (mgr != null) routeSpeaker(mgr, on);
    }

    static void audioEnd(Context context) {
        AudioManager mgr = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (mgr == null) return;
        routeSpeaker(mgr, false);
        mgr.setMode(AudioManager.MODE_NORMAL);
    }

    private static void routeSpeaker(AudioManager mgr, boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!on) {
                mgr.clearCommunicationDevice();
                return;
            }
            for (AudioDeviceInfo dev : mgr.getAvailableCommunicationDevices()) {
                if (dev.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    mgr.setCommunicationDevice(dev);
                    return;
                }
            }
        } else {
            mgr.setSpeakerphoneOn(on);
        }
    }

    private static boolean ensureMicPermission() {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        Seru24Activity.ensurePermissions(new String[]{Manifest.permission.RECORD_AUDIO}, granted -> {
            ok.set(granted);
            latch.countDown();
        });
        try {
            latch.await(120, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        return ok.get();
    }

    private static synchronized void ensureFactory(Context context) {
        if (!initialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.getApplicationContext())
                    .createInitializationOptions()
            );
            initialized = true;
        }
        if (factory == null) {
            JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(context.getApplicationContext())
                .createAudioDeviceModule();
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .createPeerConnectionFactory();
        }
    }

    private static synchronized PeerConnection openPeer(Context context, int bitrate) {
        close();
        ensureFactory(context);

        List<PeerConnection.IceServer> iceServers = Arrays.asList(
            PeerConnection.IceServer.builder(Arrays.asList(
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            )).createIceServer()
        );
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peer = factory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(DataChannel ch) {}
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(RtpReceiver r, MediaStream[] streams) {}

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                if (state == PeerConnection.IceConnectionState.CONNECTED) {
                    NativeBridge.onWebRtcState("connected");
                } else if (state == PeerConnection.IceConnectionState.FAILED) {
                    NativeBridge.onWebRtcState("failed");
                }
            }

            @Override
            public void onIceCandidate(IceCandidate cand) {
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("candidate", cand.sdp);
                    obj.put("sdpMid", cand.sdpMid);
                    obj.put("sdpMLineIndex", cand.sdpMLineIndex);
                    NativeBridge.onWebRtcIce(obj.toString());
                } catch (Exception ignored) {
                    // Kandidat tidak valid diabaikan.
                }
            }
        });

        audioSource = factory.createAudioSource(new MediaConstraints());
        audioTrack = factory.createAudioTrack("seru24-mic", audioSource);
        audioTrack.setEnabled(true);
        if (peer != null) {
            peer.addTrack(audioTrack, Collections.singletonList("seru24-stream"));
            applyBitrate(peer, bitrate);
        }
        return peer;
    }

    private static void applyBitrate(PeerConnection pc, int bitrate) {
        if (bitrate <= 0) return;
        for (RtpSender sender : pc.getSenders()) {
            if (sender.track() != null && "audio".equals(sender.track().kind())) {
                RtpParameters params = sender.getParameters();
                if (params != null && params.encodings != null && !params.encodings.isEmpty()) {
                    params.encodings.get(0).maxBitrateBps = bitrate;
                    sender.setParameters(params);
                }
            }
        }
    }

    static boolean createOffer(Context context, int bitrate) {
        if (!ensureMicPermission()) return false;
        PeerConnection pc = openPeer(context, bitrate);
        if (pc == null) return false;
        MediaConstraints mc = new MediaConstraints();
        pc.createOffer(new SimpleSdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sdp) {
                pc.setLocalDescription(new SimpleSdpObserver() {
                    @Override
                    public void onSetSuccess() {
                        NativeBridge.onWebRtcOffer(sdp.description);
                    }
                }, sdp);
            }
        }, mc);
        return true;
    }

    static void handleOffer(Context context, String sdpText, int bitrate) {
        if (!ensureMicPermission()) {
            NativeBridge.onWebRtcState("failed");
            return;
        }
        PeerConnection pc = openPeer(context, bitrate);
        if (pc == null) {
            NativeBridge.onWebRtcState("failed");
            return;
        }
        SessionDescription remote = new SessionDescription(SessionDescription.Type.OFFER, sdpText);
        pc.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                pc.createAnswer(new SimpleSdpObserver() {
                    @Override
                    public void onCreateSuccess(SessionDescription ans) {
                        pc.setLocalDescription(new SimpleSdpObserver() {
                            @Override
                            public void onSetSuccess() {
                                NativeBridge.onWebRtcAnswer(ans.description);
                            }
                        }, ans);
                    }
                }, new MediaConstraints());
            }

            @Override
            public void onSetFailure(String err) {
                NativeBridge.onWebRtcState("failed");
            }
        }, remote);
    }

    static synchronized void handleAnswer(String sdpText) {
        if (peer == null) return;
        SessionDescription remote = new SessionDescription(SessionDescription.Type.ANSWER, sdpText);
        peer.setRemoteDescription(new SimpleSdpObserver(), remote);
    }

    static synchronized void addIce(String candidateJson) {
        if (peer == null || candidateJson == null) return;
        try {
            JSONObject obj = new JSONObject(candidateJson);
            String sdp = obj.optString("candidate", "");
            String mid = obj.optString("sdpMid", "");
            int idx = obj.optInt("sdpMLineIndex", 0);
            if (!sdp.isEmpty()) {
                peer.addIceCandidate(new IceCandidate(mid, idx, sdp));
            }
        } catch (Exception ignored) {
            // Kandidat ICE tidak valid diabaikan.
        }
    }

    static synchronized void setMuted(boolean muted) {
        if (audioTrack != null) {
            audioTrack.setEnabled(!muted);
        }
    }

    static synchronized void close() {
        if (peer != null) {
            try { peer.close(); } catch (Exception ignored) {}
            try { peer.dispose(); } catch (Exception ignored) {}
            peer = null;
        }
        if (audioTrack != null) {
            try { audioTrack.dispose(); } catch (Exception ignored) {}
            audioTrack = null;
        }
        if (audioSource != null) {
            try { audioSource.dispose(); } catch (Exception ignored) {}
            audioSource = null;
        }
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sdp) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String err) {}
        @Override public void onSetFailure(String err) {}
    }
}
