// Image Board Helper's keyframe decoder: FFmpeg's H.264 decoder, one
// keyframe in, one RGBA picture out. The hold slideshow reads the keyframe
// of each scene from the MP4 (AVCC samples, the avcC record as extradata)
// and draws what comes out in a canvas; Firefox for Android has no WebCodecs
// decoders, and this needs no <video> and no hardware decoder slot.
//
// Built by build.sh. The JavaScript side copies bytes in with buf_alloc,
// calls dec_open once per video and dec_frame once per keyframe, then reads
// dec_width() x dec_height() pixels at dec_rgba().

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"

static AVCodecContext *ctx;
static AVPacket *pkt;
static AVFrame *frame;
static uint8_t *rgba;
static int rgba_cap, out_w, out_h;
static int decode_us, convert_us;   // the last dec_frame's two halves, for the log

static long long now_us(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000000LL + t.tv_nsec / 1000;
}

EMSCRIPTEN_KEEPALIVE void *buf_alloc(int n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void buf_free(void *p) { free(p); }
EMSCRIPTEN_KEEPALIVE int dec_width(void) { return out_w; }
EMSCRIPTEN_KEEPALIVE int dec_height(void) { return out_h; }
EMSCRIPTEN_KEEPALIVE uint8_t *dec_rgba(void) { return rgba; }
EMSCRIPTEN_KEEPALIVE int dec_decode_us(void) { return decode_us; }
EMSCRIPTEN_KEEPALIVE int dec_convert_us(void) { return convert_us; }

EMSCRIPTEN_KEEPALIVE void dec_close(void) {
  avcodec_free_context(&ctx);
  av_packet_free(&pkt);
  av_frame_free(&frame);
}

// A decoder for one video; extra is the avcC box's payload. 0 when ready.
EMSCRIPTEN_KEEPALIVE int dec_open(const uint8_t *extra, int size) {
  av_log_set_level(AV_LOG_QUIET);
  dec_close();
  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  if (!codec) return -1;
  ctx = avcodec_alloc_context3(codec);
  pkt = av_packet_alloc();
  frame = av_frame_alloc();
  if (!ctx || !pkt || !frame) return -2;
  // The decoder reads a little past the end: padded, as FFmpeg asks.
  ctx->extradata = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
  if (!ctx->extradata) return -2;
  memcpy(ctx->extradata, extra, size);
  ctx->extradata_size = size;
  ctx->thread_count = 1;
  return avcodec_open2(ctx, codec, NULL) < 0 ? -3 : 0;
}

// YUV to RGB in 10-bit fixed point, BT.709 for HD and BT.601 for SD, in the
// video's own range (full for JPEG-range YUV, else 16-235).
static void to_rgba(const AVFrame *f, int step, int full, int hd) {
  const int ys = full ? 1024 : 1192;   // 1.164 for 16-235
  const int rv = hd ? (full ? 1613 : 1836) : (full ? 1436 : 1634);
  const int gu = hd ? (full ? 192 : 218) : (full ? 352 : 401);
  const int gv = hd ? (full ? 479 : 546) : (full ? 731 : 833);
  const int bu = hd ? (full ? 1900 : 2163) : (full ? 1815 : 2066);
  const int area = step * step;
  uint8_t *o = rgba;
  for (int y = 0; y < out_h; y++) {
    const int sy = y * step;
    const uint8_t *u = f->data[1] + (sy >> 1) * f->linesize[1];
    const uint8_t *v = f->data[2] + (sy >> 1) * f->linesize[2];
    for (int x = 0; x < out_w; x++) {
      const int sx = x * step;
      // Luma averaged over the step x step block it stands for.
      int sum = 0;
      for (int j = 0; j < step; j++) {
        const uint8_t *row = f->data[0] + (sy + j) * f->linesize[0] + sx;
        for (int i = 0; i < step; i++) sum += row[i];
      }
      const int yy = ((sum / area) - (full ? 0 : 16)) * ys;
      const int cu = u[sx >> 1] - 128;
      const int cv = v[sx >> 1] - 128;
      int r = (yy + rv * cv + 512) >> 10;
      int g = (yy - gu * cu - gv * cv + 512) >> 10;
      int b = (yy + bu * cu + 512) >> 10;
      o[0] = r < 0 ? 0 : r > 255 ? 255 : r;
      o[1] = g < 0 ? 0 : g > 255 ? 255 : g;
      o[2] = b < 0 ? 0 : b > 255 ? 255 : b;
      o[3] = 255;
      o += 4;
    }
  }
}

// Decodes one keyframe (an AVCC sample) and converts it, halved until one
// more halving would go below max_w (0: full size). 0 on success.
EMSCRIPTEN_KEEPALIVE int dec_frame(const uint8_t *data, int size, int max_w) {
  if (!ctx) return -1;
  const long long t0 = now_us();
  avcodec_flush_buffers(ctx);   // each keyframe stands alone
  if (av_new_packet(pkt, size) < 0) return -2;   // padded copy
  memcpy(pkt->data, data, size);
  pkt->flags = AV_PKT_FLAG_KEY;
  int r = avcodec_send_packet(ctx, pkt);
  av_packet_unref(pkt);
  if (r < 0) return -3;
  avcodec_send_packet(ctx, NULL);   // drain: a lone keyframe comes out now
  if (avcodec_receive_frame(ctx, frame) < 0) return -4;
  const long long t1 = now_us();
  decode_us = (int)(t1 - t0);
  const int fmt = frame->format;
  if (fmt != AV_PIX_FMT_YUV420P && fmt != AV_PIX_FMT_YUVJ420P) { av_frame_unref(frame); return -5; }
  int step = 1;
  while (max_w > 0 && step < 8 && frame->width / (step * 2) >= max_w) step *= 2;
  out_w = frame->width / step;
  out_h = frame->height / step;
  const int need = out_w * out_h * 4;
  if (need > rgba_cap) {
    free(rgba);
    rgba = malloc(need);
    rgba_cap = rgba ? need : 0;
    if (!rgba) { av_frame_unref(frame); return -2; }
  }
  const int full = fmt == AV_PIX_FMT_YUVJ420P || frame->color_range == AVCOL_RANGE_JPEG;
  const int hd = frame->colorspace == AVCOL_SPC_BT709 ||
    (frame->colorspace == AVCOL_SPC_UNSPECIFIED && frame->height >= 720);
  to_rgba(frame, step, full, hd);
  convert_us = (int)(now_us() - t1);
  av_frame_unref(frame);
  return 0;
}
