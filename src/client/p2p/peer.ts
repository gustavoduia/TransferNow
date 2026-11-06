type SignalMessage =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

export interface IceConfig {
  iceServers: RTCIceServer[];
  turn: boolean;
}

/** Credenciais novas a cada conexão (as do TURN são temporárias). */
export function fetchIceConfig(): Promise<IceConfig> {
  return fetch("/api/ice")
    .then((r) => r.json() as Promise<IceConfig>)
    .catch(() => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], turn: false }));
}

/**
 * Conexão WebRTC entre os dois portais. Quem envia é sempre quem inicia (cria a oferta
 * e o DataChannel), então não há colisão de ofertas.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly channel: Promise<RTCDataChannel>;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private failedCb: ((reason: string) => void) | null = null;

  constructor(
    ice: IceConfig,
    private initiator: boolean,
    private sendSignal: (data: SignalMessage) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ice.iceServers });

    this.pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) this.sendSignal({ kind: "candidate", candidate: ev.candidate.toJSON() });
    });
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc.connectionState === "failed") this.failedCb?.("connection_failed");
    });

    if (initiator) {
      const dc = this.pc.createDataChannel("portal", { ordered: true });
      this.channel = waitOpen(dc);
      this.pc.addEventListener("negotiationneeded", () => void this.makeOffer());
    } else {
      this.channel = new Promise((resolve) => {
        this.pc.addEventListener("datachannel", (ev) => resolve(waitOpen(ev.channel)));
      });
    }
  }

  onFailed(cb: (reason: string) => void) {
    this.failedCb = cb;
  }

  private async makeOffer() {
    await this.pc.setLocalDescription();
    this.sendSignal({ kind: "description", description: this.pc.localDescription!.toJSON() });
  }

  async handleSignal(raw: unknown) {
    const msg = raw as SignalMessage;
    if (msg?.kind === "description") {
      await this.pc.setRemoteDescription(msg.description);
      for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      if (msg.description.type === "offer") {
        await this.pc.setLocalDescription();
        this.sendSignal({ kind: "description", description: this.pc.localDescription!.toJSON() });
      }
    } else if (msg?.kind === "candidate") {
      if (!this.pc.remoteDescription) this.pendingCandidates.push(msg.candidate);
      else await this.pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  }

  /** true quando a conexão passa pelo TURN (rede bloqueou o caminho direto). */
  async usesRelay(): Promise<boolean> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      let localId: string | undefined;
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.id === pairId || (!pairId && s.nominated && s.state === "succeeded")))
          localId = s.localCandidateId;
      });
      let relay = false;
      stats.forEach((s) => {
        if (s.id === localId && s.candidateType === "relay") relay = true;
      });
      return relay;
    } catch {
      return false;
    }
  }

  close() {
    this.pc.close();
  }
}

function waitOpen(dc: RTCDataChannel): Promise<RTCDataChannel> {
  dc.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    if (dc.readyState === "open") return resolve(dc);
    dc.addEventListener("open", () => resolve(dc), { once: true });
    dc.addEventListener("error", () => reject(new Error("datachannel_error")), { once: true });
  });
}
