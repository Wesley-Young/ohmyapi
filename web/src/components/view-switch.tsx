import { SegmentGroup } from '@chakra-ui/react';
import type { ReactNode } from 'react';

export interface ViewOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** 在几个互斥的视图、范围或模式之间切换的分段控件，方向键可在选项间移动。 */
export function ViewSwitch<T extends string>({
  label,
  items,
  value,
  onChange,
  disabled,
}: {
  label: string;
  items: readonly ViewOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentGroup.Root
      size="sm"
      value={value}
      disabled={disabled}
      aria-label={label}
      // 放在纵向 Stack 中时不被拉伸，宽度只由选项决定。
      w="fit-content"
      css={{ '--segment-radius': 'radii.full' }}
      onValueChange={(details) => {
        const next = items.find((item) => item.value === details.value);
        if (next) onChange(next.value);
      }}
    >
      <SegmentGroup.Indicator _motionReduce={{ '--transition-duration': '0ms' }} />
      <SegmentGroup.Items items={[...items]} color="gray.600" _checked={{ color: '#171717' }} />
    </SegmentGroup.Root>
  );
}
