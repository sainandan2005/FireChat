import Image from "next/image";

const SIZES = {
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-12 text-base",
} as const;

export default function Avatar({
  username,
  avatarUrl,
  size = "md",
  online,
}: {
  username: string;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
  online?: boolean;
}) {
  const initials = username.slice(0, 2).toUpperCase();

  return (
    <div className="relative shrink-0">
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-full bg-ink-600 ring-1 ring-line-strong font-semibold text-mist-200 ${SIZES[size]}`}
      >
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={username}
            fill
            sizes="48px"
            unoptimized
            className="object-cover"
          />
        ) : (
          initials
        )}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-900 ${
            online ? "bg-online" : "bg-ink-500"
          }`}
          aria-label={online ? "online" : "offline"}
        />
      )}
    </div>
  );
}
