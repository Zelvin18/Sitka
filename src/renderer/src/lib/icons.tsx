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

export const IconPlus = (p: IconProps) =>
  base(p.size, p.strokeWidth, <path d="M12 5v14M5 12h14" />)

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

export const IconNotes = (p: IconProps) =>
  base(
    p.size,
    p.strokeWidth,
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  )
