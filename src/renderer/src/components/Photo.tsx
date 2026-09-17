import React, { useState } from 'react'
import { PLACEHOLDERS } from '@shared/placeholders'

const IS_WEB = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true

/**
 * A photograph that is never a hole. The blurred glimpse carried in the code
 * fills the space the instant the page draws, and the real picture fades in
 * over it when it arrives; on a second visit that is the same instant.
 */
export default function Photo({
  name,
  ext = 'webp',
  className = '',
  position,
  onMissing
}: {
  /** the file's name in web/public, without its extension */
  name: string
  ext?: 'webp' | 'jpeg' | 'jpg' | 'png'
  className?: string
  /** object-position for the picture, e.g. "68% center" */
  position?: string
  onMissing?: () => void
}): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const src = IS_WEB ? `/${name}.${ext}` : `https://sitcaai.vercel.app/${name}.${ext}`
  const glimpse = PLACEHOLDERS[name]
  return (
    <div className={`photo-frame${ready ? ' in' : ''} ${className}`.trim()} aria-hidden="true">
      {glimpse && <div className="photo-glimpse" style={{ backgroundImage: `url(${glimpse})`, backgroundPosition: position }} />}
      <img
        className="photo-img"
        src={src}
        alt=""
        decoding="async"
        fetchPriority="high"
        style={position ? { objectPosition: position } : undefined}
        onLoad={() => setReady(true)}
        onError={() => onMissing?.()}
      />
    </div>
  )
}
