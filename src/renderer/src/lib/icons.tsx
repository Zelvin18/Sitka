import React from 'react'

interface IconProps {
  size?: number
  strokeWidth?: number
}

function base(
  size: number | undefined,
  strokeWidth: number | undefined,
  children: React.ReactNode
): React.JSX.Element {
  return (
    <svg
      className="icon"
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/**
 * Sitka mark ("Halo"): the loop of everything said, and the one moment held on it.
 * With `live`, the point orbits the ring — Sitka is thinking or working.
 */
export const Mark = ({ size, live }: { size?: number; live?: boolean }) => (
  <svg
    className={live ? 'mark mark-live' : 'mark'}
    width={size ?? 18}
    height={size ?? 18}
    viewBox="0 0 64 64"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="9" />
    <g className="mark-orbit">
      <circle cx="46.1" cy="17.9" r="9" />
      {live && (
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 32 32"
          to="360 32 32"
          dur="1.6s"
          repeatCount="indefinite"
        />
      )}
    </g>
  </svg>
)

export const IconPlus = (p: IconProps) =>
  base(p.size, p.strokeWidth, <path d="M12 5v14M5 12h14" />)

export const IconWand = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M4 20 14.5 9.5" />
      <path d="M13 8l3 3" />
      <path d="M17.5 3v2.5M17.5 9.5V12M14 6.25h2.5M20.5 6.25H23" transform="translate(-2 0)" />
    </>
  )

export const IconDoc = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  )

export const IconSlides = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M8.5 20h7M7 12l3-3 2.5 2.5L16 8" />
    </>
  )

export const IconCode = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="m8 8-4.5 4L8 16M16 8l4.5 4L16 16M13.5 5l-3 14" />
    </>
  )

export const IconBriefcase = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
      <path d="M9 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2M3 12.5h18" />
    </>
  )

export const IconCap = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M2.5 9.5 12 5l9.5 4.5L12 14z" />
      <path d="M6.5 11.8v4.2c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.2M21.5 9.5v5" />
    </>
  )

export const IconShare = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
    </>
  )

export const IconLink = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </>
  )

export const IconHome = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </>
  )

export const IconSettings = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </>
  )

export const IconMic = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </>
  )

export const IconScreen = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  )

export const IconPlay = (p: IconProps) =>
  base(p.size, p.strokeWidth, <path d="M6 4.5v15l13-7.5z" />)

export const IconStop = (p: IconProps) =>
  base(p.size, p.strokeWidth, <rect x="6" y="6" width="12" height="12" rx="2" />)

export const IconSend = (p: IconProps) =>
  base(p.size, p.strokeWidth, <path d="M12 19V5M5 12l7-7 7 7" />)

export const IconSparkle = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z" />
    </>
  )

export const IconTrash = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </>
  )

export const IconBack = (p: IconProps) =>
  base(p.size, p.strokeWidth, <path d="M15 18l-6-6 6-6" />)

export const IconClock = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </>
  )

export const IconStar = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
  )

export const IconHelp = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.8 2.2-2.8 4" />
      <path d="M12 17.5v.01" />
    </>
  )

export const IconFolder = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  )

export const IconCamera = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="M15.5 10.5 21 7.5v9l-5.5-3z" />
    </>
  )

export const IconCalendar = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  )

export const IconBroadcast = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14" />
    </>
  )

export const IconSpeaker = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M11 5 6.5 8.5H3v7h3.5L11 19z" />
      <path d="M15 9a4.2 4.2 0 0 1 0 6M17.8 6.5a8 8 0 0 1 0 11" />
    </>
  )

export const IconCopy = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  )

export const IconDots = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <circle cx="12" cy="5.5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="18.5" r="1" />
    </>
  )

export const IconPanel = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </>
  )

export const IconEdit = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M17 3.5l3.5 3.5L8 19.5 4 20l.5-4z" />
    </>
  )

export const IconDownload = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <path d="M12 3v12M6.5 9.5L12 15l5.5-5.5" />
      <path d="M4 20h16" />
    </>
  )

export const IconChevron = (p: IconProps) => base(p.size, p.strokeWidth, <path d="M6 9l6 6 6-6" />)

export const IconQr = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20 14v1M17 20h4M20 18v3" />
    </>
  )

/** the sidebar toggle: two bars, the lower one shorter */
export const IconMenu = (p: IconProps) => base(p.size, p.strokeWidth, <path d="M4 7.5h16M4 14.5h10" />)

export const IconNotes = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  )
