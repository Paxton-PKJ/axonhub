// 职责: 解析请求列表与请求详情展示所需的渠道上游 API 密钥名称及尾号信息。
// 关联文件:
//   frontend/src/features/requests/data/schema.ts
//   frontend/src/features/requests/components/requests-columns.tsx
//   frontend/src/features/requests/components/request-detail-content.tsx
// 遵循的 Rules:
//   .agents/rules/frontend-general.md
// 注意事项:
//   已删除密钥仅在详情页保留尾号（方式 A），列表页显示为空。
//   channelAPIKeyLabel 为 null（无指纹的旧记录）时回退使用静态 channelAPIKeyIndex。

import type { RequestExecution } from '../data/schema';

export type RequestExecutionAPIKeyDisplaySource = Pick<
  RequestExecution,
  'channelAPIKeyLabel' | 'channelAPIKeyIndex' | 'channelAPIKeySuffix'
>;

export interface RequestDetailAPIKeyDisplay {
  label: string | null;
  suffix: string | null;
  visible: boolean;
}

export function resolveRequestListAPIKeyLabel(
  execution?: Pick<RequestExecution, 'channelAPIKeyLabel' | 'channelAPIKeyIndex'> | null
): string | null {
  if (!execution) {
    return null;
  }

  const label = execution.channelAPIKeyLabel;
  if (label != null) {
    if (label.deleted) {
      return null;
    }
    if (label.name) {
      return label.name;
    }
    if (label.index != null) {
      return `key${label.index}`;
    }
    return null;
  }

  return execution.channelAPIKeyIndex != null ? `key${execution.channelAPIKeyIndex}` : null;
}

export function resolveRequestDetailAPIKeyDisplay(
  execution?: RequestExecutionAPIKeyDisplaySource | null
): RequestDetailAPIKeyDisplay {
  const label = resolveRequestListAPIKeyLabel(execution);
  const suffix = execution?.channelAPIKeySuffix || null;
  return {
    label,
    suffix,
    visible: Boolean(label || suffix),
  };
}
