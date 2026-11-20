//! Mesin status panggilan suara 1-ke-1 WebRTC (`web/shared/call-core.ts`).

use serde::{Deserialize, Serialize};

pub const CALL_EVENT: &str = "call";
pub const CALL_RING_TIMEOUT_MS: u64 = 45_000;
pub const DEFAULT_STUN_URLS: [&str; 2] = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallPhase {
    Idle,
    Calling,
    Incoming,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CallEndReason {
    Hangup,
    Rejected,
    Busy,
    Timeout,
    Failed,
    MicDenied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceCandidate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(rename = "sdpMid", default, skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(
        rename = "sdpMLineIndex",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sdp_mline_index: Option<u32>,
    #[serde(
        rename = "usernameFragment",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub username_fragment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallSignalType {
    Invite,
    Accept,
    Reject,
    Busy,
    Offer,
    Answer,
    Ice,
    Hangup,
    Record,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallSignal {
    #[serde(rename = "type")]
    pub signal_type: CallSignalType,
    #[serde(rename = "callId")]
    pub call_id: String,
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<IceCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallAction {
    EmitSignal(CallSignal),
    StartRingTimeout { notify_peer_on_timeout: bool },
    ClearRingTimeout,
    CreateOffer { sdp_needed: bool },
    SetRemoteOfferAndCreateAnswer { sdp: String },
    SetRemoteAnswer { sdp: String },
    AddIceCandidate(IceCandidate),
    Teardown(CallEndReason),
    PeerRecording(bool),
}

/// Mesin status deterministik panggilan 1-1 agar dapat diuji murni di desktop.
pub struct CallStateMachine {
    my_id: String,
    phase: CallPhase,
    call_id: String,
    peer_recording: bool,
}

impl CallStateMachine {
    pub fn new(my_id: impl Into<String>) -> Self {
        Self {
            my_id: my_id.into(),
            phase: CallPhase::Idle,
            call_id: String::new(),
            peer_recording: false,
        }
    }

    pub fn phase(&self) -> CallPhase {
        self.phase
    }

    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn peer_recording(&self) -> bool {
        self.peer_recording
    }

    fn signal(&self, signal_type: CallSignalType) -> CallSignal {
        CallSignal {
            signal_type,
            call_id: self.call_id.clone(),
            from: self.my_id.clone(),
            sdp: None,
            candidate: None,
            on: None,
        }
    }

    fn reset(&mut self) {
        self.phase = CallPhase::Idle;
        self.call_id.clear();
        self.peer_recording = false;
    }

    pub fn start_outgoing(&mut self, call_id: String, mic_granted: bool) -> Vec<CallAction> {
        if self.phase != CallPhase::Idle {
            return Vec::new();
        }
        if !mic_granted {
            return vec![CallAction::Teardown(CallEndReason::MicDenied)];
        }
        self.call_id = call_id;
        self.phase = CallPhase::Calling;
        vec![
            CallAction::EmitSignal(self.signal(CallSignalType::Invite)),
            CallAction::StartRingTimeout {
                notify_peer_on_timeout: true,
            },
        ]
    }

    pub fn accept_incoming(&mut self, mic_granted: bool) -> Vec<CallAction> {
        if self.phase != CallPhase::Incoming {
            return Vec::new();
        }
        if !mic_granted {
            let reject = self.signal(CallSignalType::Reject);
            self.reset();
            return vec![
                CallAction::ClearRingTimeout,
                CallAction::EmitSignal(reject),
                CallAction::Teardown(CallEndReason::MicDenied),
            ];
        }
        self.phase = CallPhase::Connecting;
        vec![
            CallAction::ClearRingTimeout,
            CallAction::EmitSignal(self.signal(CallSignalType::Accept)),
        ]
    }

    pub fn reject_incoming(&mut self) -> Vec<CallAction> {
        if self.phase != CallPhase::Incoming {
            return Vec::new();
        }
        let reject = self.signal(CallSignalType::Reject);
        self.reset();
        vec![
            CallAction::ClearRingTimeout,
            CallAction::EmitSignal(reject),
            CallAction::Teardown(CallEndReason::Rejected),
        ]
    }

    pub fn hangup(&mut self) -> Vec<CallAction> {
        if self.phase == CallPhase::Idle {
            return Vec::new();
        }
        let hangup = self.signal(CallSignalType::Hangup);
        self.reset();
        vec![
            CallAction::ClearRingTimeout,
            CallAction::EmitSignal(hangup),
            CallAction::Teardown(CallEndReason::Hangup),
        ]
    }

    pub fn on_connected(&mut self) -> Vec<CallAction> {
        if self.phase == CallPhase::Idle {
            return Vec::new();
        }
        self.phase = CallPhase::Connected;
        vec![CallAction::ClearRingTimeout]
    }

    pub fn on_ring_timeout(&mut self, notify_peer: bool) -> Vec<CallAction> {
        if self.phase == CallPhase::Idle {
            return Vec::new();
        }
        let mut actions = Vec::new();
        if notify_peer {
            actions.push(CallAction::EmitSignal(self.signal(CallSignalType::Hangup)));
        }
        self.reset();
        actions.push(CallAction::Teardown(CallEndReason::Timeout));
        actions
    }

    pub fn announce_recording(&self, on: bool) -> Option<CallSignal> {
        if self.phase != CallPhase::Connected {
            return None;
        }
        let mut sig = self.signal(CallSignalType::Record);
        sig.on = Some(on);
        Some(sig)
    }

    pub fn handle_signal(&mut self, sig: CallSignal) -> Vec<CallAction> {
        if sig.from == self.my_id || sig.call_id.is_empty() {
            return Vec::new();
        }
        if sig.signal_type == CallSignalType::Invite {
            if self.phase != CallPhase::Idle {
                return vec![CallAction::EmitSignal(CallSignal {
                    signal_type: CallSignalType::Busy,
                    call_id: sig.call_id,
                    from: self.my_id.clone(),
                    sdp: None,
                    candidate: None,
                    on: None,
                })];
            }
            self.call_id = sig.call_id;
            self.phase = CallPhase::Incoming;
            return vec![CallAction::StartRingTimeout {
                notify_peer_on_timeout: false,
            }];
        }
        if self.phase == CallPhase::Idle || sig.call_id != self.call_id {
            return Vec::new();
        }
        match sig.signal_type {
            CallSignalType::Accept if self.phase == CallPhase::Calling => {
                self.phase = CallPhase::Connecting;
                vec![
                    CallAction::ClearRingTimeout,
                    CallAction::CreateOffer { sdp_needed: true },
                ]
            }
            CallSignalType::Offer if self.phase == CallPhase::Connecting => match sig.sdp {
                Some(sdp) if !sdp.is_empty() => {
                    vec![CallAction::SetRemoteOfferAndCreateAnswer { sdp }]
                }
                _ => Vec::new(),
            },
            CallSignalType::Answer => match sig.sdp {
                Some(sdp) if !sdp.is_empty() => vec![CallAction::SetRemoteAnswer { sdp }],
                _ => Vec::new(),
            },
            CallSignalType::Ice => match sig.candidate {
                Some(candidate) => vec![CallAction::AddIceCandidate(candidate)],
                None => Vec::new(),
            },
            CallSignalType::Reject => {
                self.reset();
                vec![
                    CallAction::ClearRingTimeout,
                    CallAction::Teardown(CallEndReason::Rejected),
                ]
            }
            CallSignalType::Busy => {
                self.reset();
                vec![
                    CallAction::ClearRingTimeout,
                    CallAction::Teardown(CallEndReason::Busy),
                ]
            }
            CallSignalType::Hangup => {
                self.reset();
                vec![
                    CallAction::ClearRingTimeout,
                    CallAction::Teardown(CallEndReason::Hangup),
                ]
            }
            CallSignalType::Record => {
                let on = sig.on == Some(true);
                self.peer_recording = on;
                vec![CallAction::PeerRecording(on)]
            }
            _ => Vec::new(),
        }
    }
}
