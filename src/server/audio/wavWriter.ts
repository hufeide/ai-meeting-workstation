import { closeSync, openSync, writeSync } from "node:fs";

export class WavWriter {
  private readonly fd: number;
  private bytesWritten = 0;

  constructor(
    private readonly filePath: string,
    private readonly sampleRate: number
  ) {
    this.fd = openSync(filePath, "w");
    writeSync(this.fd, createWavHeader({ sampleRate, dataBytes: 0 }));
  }

  writePcm16(chunk: Buffer): void {
    writeSync(this.fd, chunk);
    this.bytesWritten += chunk.byteLength;
  }

  close(): { path: string; durationMs: number } {
    writeSync(this.fd, createWavHeader({ sampleRate: this.sampleRate, dataBytes: this.bytesWritten }), 0, 44, 0);
    closeSync(this.fd);
    return {
      path: this.filePath,
      durationMs: Math.round((this.bytesWritten / 2 / this.sampleRate) * 1000)
    };
  }
}

function createWavHeader(input: { sampleRate: number; dataBytes: number }): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = input.sampleRate * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + input.dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(input.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(input.dataBytes, 40);

  return header;
}
