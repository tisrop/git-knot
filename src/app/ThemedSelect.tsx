import { CaretDown, Check } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export interface ThemedSelectOption {
  disabled?: boolean;
  group?: string;
  label: string;
  value: string;
}

interface ThemedSelectProps {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: ThemedSelectOption[];
  value: string;
}

interface PopoverPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

function nextEnabledIndex(options: ThemedSelectOption[], current: number, direction: 1 | -1) {
  if (options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function shouldDismissThemedSelect(key: string, isComposing: boolean) {
  return key === "Escape" && !isComposing;
}

function edgeEnabledIndex(options: ThemedSelectOption[], fromEnd: boolean) {
  const indexes = options.map((_, index) => index);
  if (fromEnd) indexes.reverse();
  return indexes.find((index) => !options[index]?.disabled) ?? -1;
}

export function ThemedSelect({
  ariaLabel,
  className = "",
  disabled = false,
  onChange,
  options,
  value,
}: ThemedSelectProps) {
  const listboxId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex] ?? options.find((option) => !option.disabled);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  function updatePosition() {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const groupCount = new Set(options.map((option) => option.group).filter(Boolean)).size;
    const estimatedHeight = Math.min(288, Math.max(44, options.length * 30 + groupCount * 22 + 8));
    const availableBelow = window.innerHeight - rect.bottom - 8;
    const openAbove = availableBelow < Math.min(estimatedHeight, 180) && rect.top > availableBelow;
    const maxHeight = Math.max(88, Math.min(288, openAbove ? rect.top - 12 : availableBelow));
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = openAbove
      ? Math.max(8, rect.top - Math.min(estimatedHeight, maxHeight) - 5)
      : rect.bottom + 5;
    setPosition({ left, maxHeight, top, width });
  }

  function openListbox(preferredIndex = selectedIndex) {
    if (disabled || options.length === 0) return;
    const fallbackIndex = edgeEnabledIndex(options, false);
    setActiveIndex(
      preferredIndex >= 0 && !options[preferredIndex]?.disabled ? preferredIndex : fallbackIndex,
    );
    setOpen(true);
  }

  function selectIndex(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openListbox();
        return;
      }
      setActiveIndex((current) =>
        nextEnabledIndex(
          options,
          current < 0 ? selectedIndex : current,
          event.key === "ArrowDown" ? 1 : -1,
        ),
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex(edgeEnabledIndex(options, event.key === "End"));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) selectIndex(activeIndex);
      else openListbox();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (!shouldDismissThemedSelect(event.key, event.isComposing)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const handleReposition = () => updatePosition();
    window.addEventListener("keydown", handleEscape, true);
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, options]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`themed-select${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
        }
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        role="combobox"
        onClick={() => (open ? setOpen(false) : openListbox())}
        onKeyDown={handleKeyDown}
      >
        <span>{selectedOption?.label ?? "暂无选项"}</span>
        <CaretDown size={12} weight="bold" aria-hidden="true" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              id={listboxId}
              className="themed-select-popover"
              role="listbox"
              aria-label={ariaLabel}
              style={position}
            >
              {options.map((option, index) => {
                const previousGroup = index > 0 ? options[index - 1]?.group : undefined;
                const showGroup = Boolean(option.group && option.group !== previousGroup);
                const selected = option.value === value;
                return (
                  <div key={`${option.group ?? ""}:${option.value}`}>
                    {showGroup ? (
                      <div className="themed-select-group" role="presentation">
                        {option.group}
                      </div>
                    ) : null}
                    <button
                      id={`${listboxId}-option-${index}`}
                      type="button"
                      className={`themed-select-option${selected ? " selected" : ""}${activeIndex === index ? " active" : ""}`}
                      role="option"
                      aria-selected={selected}
                      disabled={option.disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => selectIndex(index)}
                    >
                      <Check size={12} weight="bold" aria-hidden="true" />
                      <span>{option.label}</span>
                    </button>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
