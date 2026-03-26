import * as React from 'react'
import clsx from 'clsx'

export type AnimatedGenerateButtonProps = {
  className?: string
  labelIdle?: string
  labelActive?: string
  generating?: boolean
  highlightHueDeg?: number
  onClick?: (e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  id?: string
  ariaLabel?: string
  href?: string
}

const btnSurfaceClass = clsx(
  'ui-anim-btn',
  'relative flex items-center justify-center cursor-pointer select-none',
  'rounded-[24px] px-4 py-2',
  'bg-background text-foreground',
  'border border-border/20',
  'shadow-[inset_0px_1px_1px_rgba(255,255,255,0.2),inset_0px_2px_2px_rgba(255,255,255,0.15),inset_0px_4px_4px_rgba(255,255,255,0.1),inset_0px_8px_8px_rgba(255,255,255,0.05),inset_0px_16px_16px_rgba(255,255,255,0.05),0_-1px_1px_rgba(0,0,0,0.02),0_-2px_2px_rgba(0,0,0,0.03),0_-4px_4px_rgba(0,0,0,0.05),0_-8px_8px_rgba(0,0,0,0.06),0_-16px_16px_rgba(0,0,0,0.08)]',
  'transition-[box-shadow,border,background-color] duration-[400ms]',
)

export default function AnimatedGenerateButton({
  className,
  labelIdle = 'Generate',
  labelActive = 'Generating',
  generating = false,
  highlightHueDeg = 121,
  onClick,
  type = 'button',
  disabled = false,
  id,
  ariaLabel,
  href,
}: AnimatedGenerateButtonProps) {
  const label = ariaLabel || (generating ? labelActive : labelIdle)
  const style = {
    ['--highlight-hue' as string]: `${highlightHueDeg}deg`,
  } as React.CSSProperties

  const textLayers = (
    <div className="ui-anim-txt-wrapper relative flex min-w-[10em] items-center h-[1.4em]">
      <div
        className={clsx(
          'ui-anim-txt-1 absolute whitespace-nowrap left-0 right-0 flex justify-center',
          generating ? 'opacity-0' : 'animate-[ui-appear_1s_ease-in-out_forwards]',
        )}
      >
        {Array.from(labelIdle).map((ch, i) => (
          <span key={i} className="ui-anim-letter inline-block">
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </div>
      <div
        className={clsx(
          'ui-anim-txt-2 absolute whitespace-nowrap left-0 right-0 flex justify-center',
          generating ? 'opacity-100' : 'opacity-0',
        )}
      >
        {Array.from(labelActive).map((ch, i) => (
          <span key={i} className="ui-anim-letter inline-block">
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </div>
    </div>
  )

  const icon = (
    <svg
      className={clsx(
        'ui-anim-btn-svg mr-2 h-6 w-6 shrink-0',
        'fill-[color:var(--ui-anim-svg-fill)]',
        'transition-[fill,filter,opacity] duration-[400ms]',
      )}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
      />
    </svg>
  )

  return (
    <div className={clsx('relative inline-block', className)} id={id}>
      {href ? (
        <a
          href={href}
          aria-label={label}
          aria-disabled={disabled || undefined}
          onClick={(e) => {
            if (disabled) e.preventDefault()
            else onClick?.(e)
          }}
          className={clsx(btnSurfaceClass, disabled && 'pointer-events-none opacity-60 cursor-not-allowed')}
          style={style}
        >
          {icon}
          {textLayers}
        </a>
      ) : (
        <button
          type={type}
          aria-label={label}
          aria-pressed={generating}
          disabled={disabled}
          onClick={onClick as (e: React.MouseEvent<HTMLButtonElement>) => void}
          className={btnSurfaceClass}
          style={style}
        >
          {icon}
          {textLayers}
        </button>
      )}
    </div>
  )
}
