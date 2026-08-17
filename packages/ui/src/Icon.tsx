import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export type IconProps = {
  icon: IconDefinition;
  label?: string;
  size?: "sm" | "1x" | "lg";
};

export const Icon = ({ icon, label, size = "1x" }: IconProps) => (
  <FontAwesomeIcon
    aria-hidden={label === undefined}
    aria-label={label}
    icon={icon}
    role={label === undefined ? undefined : "img"}
    size={size}
  />
);
