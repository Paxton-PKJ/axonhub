import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDownToLine, ArrowUpToLine, GripVertical, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AutoCompleteSelect } from '@/components/auto-complete-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extractNumberID } from '@/lib/utils';
import type { ChannelSummary } from '@/features/channels/data/schema';
import { ORDERING_WEIGHT_MAX, ORDERING_WEIGHT_MIN, parseOrderingWeightInput } from '@/features/channels/utils/ordering-weight';
import type { ProfileChannelWeight } from '../utils/channel-weights';
import { addChannelWeight, moveChannelWeight, removeChannelWeight, setChannelWeight } from '../utils/channel-weight-list';

export interface ProfileChannelWeightsEditorProps {
  value: ProfileChannelWeight[];
  onChange: (next: ProfileChannelWeight[]) => void;
  channels: ChannelSummary[];
  isLoading?: boolean;
  portalContainer?: HTMLElement | null;
}

/**
 * react-hook-form keeps the issues of an array field on a nested node: a conflict on the
 * list itself ends up in `error.root`, and one on a single entry in `error[<index>]`, so
 * `error.message` stays empty. Returns the first message found, in that order of priority.
 */
export function firstChannelWeightsError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown> & { message?: unknown; root?: { message?: unknown } };

  if (typeof record.message === 'string' && record.message !== '') {
    return record.message;
  }

  if (typeof record.root?.message === 'string' && record.root.message !== '') {
    return record.root.message;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'root' || key === 'type' || key === 'ref') {
      continue;
    }

    const nestedMessage = (value as { message?: unknown } | null | undefined)?.message;
    if (typeof nestedMessage === 'string' && nestedMessage !== '') {
      return nestedMessage;
    }
  }

  return undefined;
}

function channelIDOf(channel: ChannelSummary): number {
  return parseInt(extractNumberID(channel.id), 10);
}

function getStatusColor(status: string) {
  switch (status) {
    case 'enabled':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800';
    case 'disabled':
      return 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700';
    case 'archived':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800';
    default:
      return 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700';
  }
}

function getTypeColor(type: string) {
  const colors = {
    openai: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400',
    anthropic: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-400',
    deepseek: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-400',
    doubao: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400',
    kimi: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950 dark:text-pink-400',
  };
  return colors[type as keyof typeof colors] || 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-900 dark:text-gray-400';
}

interface ChannelWeightRowProps {
  channelID: number;
  channel?: ChannelSummary;
  weight: number;
  index: number;
  total: number;
  onMoveToTop: (index: number) => void;
  onMoveToBottom: (index: number) => void;
  onWeightChange: (channelID: number, weight: number) => void;
  onRemove: (channelID: number) => void;
}

const ChannelWeightRow = memo(function ChannelWeightRow({
  channelID,
  channel,
  weight,
  index,
  total,
  onMoveToTop,
  onMoveToBottom,
  onWeightChange,
  onRemove,
}: ChannelWeightRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: channelID.toString() });
  const { t } = useTranslation();
  const [localWeight, setLocalWeight] = useState(weight.toString());

  useEffect(() => {
    setLocalWeight(weight.toString());
  }, [weight]);

  const handleWeightBlur = () => {
    const parsed = parseOrderingWeightInput(localWeight, ORDERING_WEIGHT_MIN, ORDERING_WEIGHT_MAX);

    if (parsed === null) {
      setLocalWeight(weight.toString());
      toast.error(
        t('apikeys.profiles.channelWeights.invalidWeight', {
          min: ORDERING_WEIGHT_MIN,
          max: ORDERING_WEIGHT_MAX,
        })
      );
      return;
    }

    if (parsed !== weight) {
      onWeightChange(channelID, parsed);
    } else {
      setLocalWeight(weight.toString());
    }
  };

  const getTypeDisplayName = (type: string) => {
    const typeKey = `channels.types.${type}` as const;
    return t(typeKey, type);
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group bg-card flex items-center gap-2 rounded-md border p-1 hover:shadow-sm ${
        isDragging ? 'ring-primary/20 relative z-50 shadow-xl ring-2' : 'hover:border-primary/20'
      }`}
    >
      {/* Drag Handle */}
      <div
        className='text-muted-foreground hover:text-foreground flex min-w-[40px] cursor-grab items-center gap-1 px-1 active:cursor-grabbing'
        {...attributes}
        {...listeners}
      >
        <GripVertical className='h-3.5 w-3.5' />
        <span className='w-[20px] text-center font-mono text-[10px]'>{index + 1}</span>
      </div>

      {/* Channel Info - Single Line Optimized */}
      <div className='flex min-w-0 flex-1 items-center gap-2'>
        <div className='flex min-w-0 items-center gap-1.5'>
          <span className='truncate text-sm font-medium'>{channel?.name ?? `#${channelID}`}</span>
          <div className='flex flex-shrink-0 gap-1'>
            {channel ? (
              <>
                <Badge variant='outline' className={`h-3.5 px-1 text-[10px] font-normal ${getTypeColor(channel.type)}`}>
                  {getTypeDisplayName(channel.type)}
                </Badge>
                <Badge variant='outline' className={`h-3.5 px-1 text-[10px] font-normal ${getStatusColor(channel.status)}`}>
                  {t(`channels.status.${channel.status}`)}
                </Badge>
              </>
            ) : (
              <Badge
                variant='outline'
                className='h-3.5 border-amber-200 bg-amber-50 px-1 text-[10px] font-normal text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400'
              >
                {t('apikeys.profiles.channelWeights.unknownChannel')}
              </Badge>
            )}
          </div>
        </div>

        <div className='hidden flex-1 items-center gap-2 sm:flex'>
          <div className='bg-border h-3 w-[1px]' />
          <span className='text-muted-foreground truncate font-mono text-[10px] opacity-70'>{channel?.baseURL ?? ''}</span>
        </div>
      </div>

      {/* Controls */}
      <div className='flex items-center gap-1 pr-1'>
        <div className='bg-muted/30 hidden items-center gap-1.5 rounded px-1.5 py-0.5 sm:flex'>
          <span className='text-muted-foreground text-[10px]'>{t('apikeys.profiles.channelWeights.weight')}</span>
          <Input
            type='number'
            inputMode='numeric'
            step={1}
            min={ORDERING_WEIGHT_MIN}
            max={ORDERING_WEIGHT_MAX}
            className='h-6 w-16 px-1 text-center text-xs'
            value={localWeight}
            onChange={(e) => setLocalWeight(e.target.value)}
            onBlur={handleWeightBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>

        <div className='flex items-center gap-0.5'>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground h-6 w-6'
            onClick={() => onMoveToTop(index)}
            disabled={index === 0}
            title={t('common.moveToTop', 'Move to top')}
          >
            <ArrowUpToLine className='h-3.5 w-3.5' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-foreground h-6 w-6'
            onClick={() => onMoveToBottom(index)}
            disabled={index === total - 1}
            title={t('common.moveToBottom', 'Move to bottom')}
          >
            <ArrowDownToLine className='h-3.5 w-3.5' />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-destructive h-6 w-6'
            onClick={() => onRemove(channelID)}
            title={t('apikeys.profiles.channelWeights.remove')}
          >
            <Trash2 className='h-3.5 w-3.5' />
          </Button>
        </div>
      </div>
    </div>
  );
});

export function ProfileChannelWeightsEditor({
  value,
  onChange,
  channels,
  isLoading = false,
  portalContainer,
}: ProfileChannelWeightsEditorProps) {
  const { t } = useTranslation();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const channelsByID = useMemo(() => {
    const map = new Map<number, ChannelSummary>();
    channels.forEach((channel) => {
      map.set(channelIDOf(channel), channel);
    });
    return map;
  }, [channels]);

  const usedChannelIDs = useMemo(() => new Set(value.map((item) => item.channelID)), [value]);

  const availableOptions = useMemo(
    () =>
      channels
        .filter((channel) => !usedChannelIDs.has(channelIDOf(channel)))
        .map((channel) => ({ value: channel.id, label: channel.name })),
    [channels, usedChannelIDs]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = value.findIndex((item) => item.channelID.toString() === active.id);
      const newIndex = value.findIndex((item) => item.channelID.toString() === over.id);

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      onChange(moveChannelWeight(value, oldIndex, newIndex));
    },
    [onChange, value]
  );

  const handleMoveToTop = useCallback(
    (index: number) => {
      onChange(moveChannelWeight(value, index, 0));
    },
    [onChange, value]
  );

  const handleMoveToBottom = useCallback(
    (index: number) => {
      onChange(moveChannelWeight(value, index, value.length - 1));
    },
    [onChange, value]
  );

  const handleWeightChange = useCallback(
    (channelID: number, weight: number) => {
      onChange(setChannelWeight(value, channelID, weight));
    },
    [onChange, value]
  );

  const handleRemove = useCallback(
    (channelID: number) => {
      onChange(removeChannelWeight(value, channelID));
    },
    [onChange, value]
  );

  const handleAdd = useCallback(
    (channelGUID: string) => {
      const channel = channels.find((item) => item.id === channelGUID);

      if (!channel) {
        return;
      }

      onChange(addChannelWeight(value, channelIDOf(channel), channel.orderingWeight ?? 0));
    },
    [channels, onChange, value]
  );

  return (
    <div className='space-y-1'>
      {value.length === 0 ? (
        <p className='text-muted-foreground py-3 text-center text-sm'>{t('apikeys.profiles.channelWeights.empty')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={value.map((item) => item.channelID.toString())} strategy={verticalListSortingStrategy}>
            <div className='space-y-1'>
              {value.map((item, index) => (
                <ChannelWeightRow
                  key={item.channelID}
                  channelID={item.channelID}
                  channel={channelsByID.get(item.channelID)}
                  weight={item.weight}
                  index={index}
                  total={value.length}
                  onMoveToTop={handleMoveToTop}
                  onMoveToBottom={handleMoveToBottom}
                  onWeightChange={handleWeightChange}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <div className='pt-1'>
        <AutoCompleteSelect
          selectedValue=''
          onSelectedValueChange={handleAdd}
          items={availableOptions}
          isLoading={isLoading}
          emptyMessage={t('apikeys.profiles.channelWeights.noMoreChannels')}
          placeholder={t('apikeys.profiles.channelWeights.add')}
          portalContainer={portalContainer}
          inputClassName='h-8 text-sm'
        />
      </div>
    </div>
  );
}
