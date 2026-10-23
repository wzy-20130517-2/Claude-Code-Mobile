#!/data/data/com.termux/files/usr/bin/bash
# audio-keepalive.sh — Termux 息屏保活（AudioTrack 静音循环）
#
# 【2026-10-22 重写：从 MediaPlayer 换成 AudioTrack MODE_STATIC】
#
# 旧实现用 termux-media-player 播 AMR 文件，每 55 秒重新 play 一次：
#   · AMR 需要解码，解码器每轮重启
#   · 文件 65 秒、循环 55 秒，等于每次都在文件没播完时重置 MediaPlayer
#   · 实测 CPU 30%+
#
# 新实现改用 AudioTrack：
#   · MODE_STATIC —— 静音 PCM 一次性写入硬件缓冲区
#   · setLoopPoints(0, frames, -1) —— 硬件无限循环，应用侧不再喂数据
#   · 实测 CPU 约 0.1%（AudioTrack 进程 + audioserver 合计）
#
# 为什么这样能保活（反编译 PowerKeeper 确认）：
#   PowerCheckerPolicy.isAudioActive(uid) 调 AudioManager.getActivePlaybackConfigurations()，
#   遍历找 clientUid == 目标 uid 且 isActive == true 的条目。
#   命中 → RULE_IGNORE_REASON_AUDIO_ACTIVE(203) → 不杀。
#   所以必须让 **Termux 自己的 uid(10286)** 持有活跃播放配置，
#   不能是别的应用（比如 DPC）代持 —— 那样 isAudioActive(10286) 仍是 false。
#
# 实现方式：以 Termux uid 跑一个 app_process 里的 AudioTrack 循环。
#   需要 root（su 10286）把进程切到 Termux uid。
#   不需要 termux-api、不需要 ffmpeg、不需要任何音频文件。
#
# 用法：
#   bash core/audio-keepalive.sh start    启动
#   bash core/audio-keepalive.sh stop     停止
#   bash core/audio-keepalive.sh status   查看状态

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
DEX="/data/local/tmp/ccm-audio.dex"
LOG="$HOME/.termux/ccm-audio.log"
TMUX_SESSION="ccm-audio"
TAG="ccm-audio-keepalive"
TERMUX_UID=10286

# 生成 dex（源码内嵌，首次运行时编译）
ensure_dex() {
  [ -f "$DEX" ] && return 0
  mkdir -p "$HOME/.termux"

  local src="$HOME/.termux/CcmAudio.java"
  cat > "$src" << 'JAVAEOF'
package com.ccm.audio;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Looper;

public class CcmAudio {
    public static void main(String[] args) throws Exception {
        Looper.prepare();

        final int sampleRate = 8000;
        final int frames = sampleRate;   // 1 秒
        final int bytes = frames * 2;    // 16bit mono

        AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setBufferSizeInBytes(bytes)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build();

        t.write(new byte[bytes], 0, bytes);
        t.setLoopPoints(0, frames, -1);
        t.play();

        System.out.println("uid=" + android.os.Process.myUid()
                + " state=" + t.getState()
                + " play=" + t.getPlayState());
        System.out.flush();

        // 不依赖 Looper（app_process 下行为不稳定），直接死循环保活。
        // AudioTrack 已在硬件层循环播放，主线程只需保持进程存活。
        while (true) {
            try { Thread.sleep(3600000L); } catch (InterruptedException ignored) { }
        }
    }
}
JAVAEOF

  # 编译 + d8（都在 Termux 本地，不用 gradle）
  local cls="$HOME/.termux/ccmaudio-classes"
  rm -rf "$cls"; mkdir -p "$cls"
  local pdir="$cls/com/ccm/audio"
  mkdir -p "$pdir"
  mv "$src" "$pdir/CcmAudio.java"
  javac -source 8 -target 8 -nowarn \
      -cp "$HOME/claude-code-mobile/tools/vd/android.jar" \
      -d "$cls" "$pdir/CcmAudio.java" 2>/dev/null || return 1
  d8 --min-api 30 --output "$cls" "$pdir/CcmAudio.class" 2>/dev/null || return 1
  # /data/local/tmp 需要 root 写入
  su -c "cp '$cls/classes.dex' '$DEX' && chmod 644 '$DEX'" 2>/dev/null \
      || { cp "$cls/classes.dex" "$DEX" 2>/dev/null; chmod 644 "$DEX" 2>/dev/null; }
  rm -rf "$cls" "$src"
  return 0
}

is_running() {
  # 用 tmux 会话判断（Termux 的 ps 看不到自己 uid 之外的 app_process 详情，
  # 而进程就活在这个会话里）。会话在 = 保活在。
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

start() {
  # 先清掉所有残留实例（多实例会让 /keepalive off 漏杀）
  local n
  n=$(pgrep -f "app_process /system/bin com.ccm.audio.CcmAudio" 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$n" ] && n=0
  if [ "$n" -gt 1 ]; then
    pkill -9 -f "app_process /system/bin com[.]ccm[.]audio[.]CcmAudio" 2>/dev/null
    sleep 1
  elif [ "$n" -eq 1 ]; then
    echo "audio-keepalive: 已在运行"
    return 0
  fi

  ensure_dex || { echo "audio-keepalive: dex 生成失败（检查 javac/d8 与 android.jar）"; return 1; }

  mkdir -p "$HOME/.termux"
  : > "$LOG"

  # 【2026-10-22 实测结论】app_process 的启动方式：
  #   1) 不用 su 切 uid —— Termux 本身就是 uid 10286，直接跑 /system/bin/app_process 即可
  #   2) 必须放在 tmux 里 —— 普通后台（nohup/setsid/spawn）都会被当孤儿进程回收，
  #      而 tmux 提供的持久伪终端能让它稳定存活（实测 30 秒 CPU 仅 10ms）
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  tmux new-session -d -s "$TMUX_SESSION" \
      "CLASSPATH=$DEX /system/bin/app_process /system/bin com.ccm.audio.CcmAudio"

  sleep 3

  if is_running; then
    echo "audio-keepalive: 已启动 ✓（AudioTrack 静音循环，CPU 约 0.1%）"
    head -1 "$LOG" 2>/dev/null
  else
    echo "audio-keepalive: 启动失败"
    cat "$LOG" 2>/dev/null | head -5
    return 1
  fi
}

stop() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  su -c "pkill -9 -f 'com[.]ccm[.]audio[.]CcmAudio'" 2>/dev/null
  echo "audio-keepalive: 已停止"
}

status() {
  if is_running; then
    echo "audio-keepalive: 运行中 ✓"
    head -1 "$LOG" 2>/dev/null
    local pid=$(pgrep -f "app_process /system/bin com.ccm.audio.CcmAudio" | head -1)
    [ -n "$pid" ] && echo "PID: $pid"
  else
    echo "audio-keepalive: 未运行"
  fi
}

case "$1" in
  ensure-dex) ensure_dex ;;  # 只生成 dex，供 index.mjs 直接 spawn 使用
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *)
    echo "用法: bash $0 start|stop|status"
    echo "AudioTrack 静音循环保活，替代旧的 MediaPlayer 方案（CPU 30% → 0.1%）"
    ;;
esac
