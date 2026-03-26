import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import { cn } from '@/lib/utils'

interface HlsVideoProps {
  src: string
  className?: string
  style?: React.CSSProperties
}

export default function HlsVideo({ src, className, style }: HlsVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (Hls.isSupported()) {
      const hls = new Hls({ autoStartLoad: true })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
      return () => hls.destroy()
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.play().catch(() => {})
    }
  }, [src])

  return (
    <video
      ref={videoRef}
      className={cn('w-full h-full object-cover', className)}
      style={style}
      autoPlay
      loop
      muted
      playsInline
    />
  )
}
