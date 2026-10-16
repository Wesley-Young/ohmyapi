import { Field, NativeSelect, Text } from '@chakra-ui/react';

import { type AccessEndpoint, storeAccessEndpointId } from '../lib/access-endpoints';

function removeScheme(url: string) {
  return url.replace(/^[a-z]+:\/\//, '');
}

/** 接入点选择；只有一个接入点时只显示它的说明。 */
export function AccessEndpointField({
  options,
  value,
  onChange,
}: {
  options: AccessEndpoint[];
  value: AccessEndpoint;
  onChange: (id: string) => void;
}) {
  if (options.length < 2) {
    return (
      value.description && (
        <Text color="gray.600" fontSize="sm" whiteSpace="pre-line">
          {value.description}
        </Text>
      )
    );
  }
  return (
    <Field.Root>
      <Field.Label>接入节点</Field.Label>
      <NativeSelect.Root>
        <NativeSelect.Field
          value={value.id}
          onChange={(event) => {
            storeAccessEndpointId(event.target.value);
            onChange(event.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label} ({removeScheme(option.baseUrl)})
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {value.description && (
        <Field.HelperText color="gray.600" whiteSpace="pre-line">
          {value.description}
        </Field.HelperText>
      )}
    </Field.Root>
  );
}
