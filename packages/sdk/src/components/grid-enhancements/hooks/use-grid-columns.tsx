import type {
  INumberShowAs,
  ISingleLineTextShowAs,
  IAttachmentCellValue,
} from '@teable-group/core';
import { CellValueType, ColorUtils, FieldType } from '@teable-group/core';
import { keyBy } from 'lodash';
import { LRUCache } from 'lru-cache';
import { useMemo } from 'react';
import colors from 'tailwindcss/colors';
import type { ChartType, ICell, IGridColumn, INumberShowAs as IGridNumberShowAs } from '../..';
import { CellType, getFileCover, hexToRGBA, onMixedTextClick } from '../..';
import { ThemeKey } from '../../../context';
import { useTablePermission, useFields, useView, useTheme } from '../../../hooks';
import type { IFieldInstance, NumberField, Record } from '../../../model';
import type { IViewInstance } from '../../../model/view';
import { getFilterFieldIds } from '../../filter/utils';
import type { IGridTheme } from '../../grid/configs';
import { GRID_DEFAULT } from '../../grid/configs';
import {
  GridAttachmentEditor,
  GridDateEditor,
  GridLinkEditor,
  GridSelectEditor,
  GridNumberEditor,
} from '../editor';
import { GridUserEditor } from '../editor/GridUserEditor';

const cellValueStringCache: LRUCache<string, string> = new LRUCache({ max: 1000 });

const iconString = (type: FieldType, isLookup: boolean | undefined) => {
  return isLookup ? `${type}_lookup` : type;
};

interface IGenerateColumnsProps {
  fields: IFieldInstance[];
  view?: IViewInstance;
  hasMenu?: boolean;
  theme?: ThemeKey;
  sortFieldIds?: Set<string>;
  groupFieldIds?: Set<string>;
  filterFieldIds?: Set<string>;
}

const getColumnThemeByField = ({
  field,
  theme,
  sortFieldIds,
  groupFieldIds,
  filterFieldIds,
}: Pick<IGenerateColumnsProps, 'theme' | 'sortFieldIds' | 'groupFieldIds' | 'filterFieldIds'> & {
  field: IFieldInstance;
}) => {
  const { id, isPending, hasError } = field;
  const { orange, green, violet, rose, yellow } = colors;
  const isDark = theme === ThemeKey.Dark;
  const color_50 = isDark ? 700 : 50;
  const color_100 = isDark ? 500 : 100;
  const color_200 = isDark ? 400 : 200;
  const opacity = isDark ? 0.3 : 0.8;
  const colorMap = {
    sort: orange,
    group: green,
    filter: violet,
  };

  let customTheme: Partial<IGridTheme> | undefined = undefined;
  let conditionColorObj = undefined;

  if (groupFieldIds?.has(id)) {
    conditionColorObj = colorMap.group;
  }

  if (sortFieldIds?.has(id)) {
    conditionColorObj = colorMap.sort;
  }

  if (filterFieldIds?.has(id)) {
    conditionColorObj = colorMap.filter;
  }

  if (conditionColorObj != null) {
    customTheme = {
      cellBg: hexToRGBA(conditionColorObj[color_50], opacity),
      cellBgHovered: hexToRGBA(conditionColorObj[color_50], opacity),
      cellBgSelected: hexToRGBA(conditionColorObj[color_100], opacity),
      columnHeaderBg: hexToRGBA(conditionColorObj[color_100], opacity),
      columnHeaderBgHovered: hexToRGBA(conditionColorObj[color_200], opacity),
      columnHeaderBgSelected: hexToRGBA(conditionColorObj[color_200], opacity),
    };
  }

  if (hasError || isPending) {
    const colorObj = hasError ? rose : yellow;

    customTheme = {
      ...customTheme,
      columnHeaderBg: hexToRGBA(colorObj[color_100], opacity),
      columnHeaderBgHovered: hexToRGBA(colorObj[color_200], opacity),
      columnHeaderBgSelected: hexToRGBA(colorObj[color_200], opacity),
    };
  }

  return customTheme;
};

const generateColumns = ({
  fields,
  view,
  theme,
  hasMenu = true,
  sortFieldIds,
  groupFieldIds,
  filterFieldIds,
}: IGenerateColumnsProps): (IGridColumn & { id: string })[] => {
  return fields
    .map((field) => {
      if (!field) return undefined;
      const columnMeta = view?.columnMeta[field.id] ?? null;
      const width = columnMeta?.width || GRID_DEFAULT.columnWidth;
      const { id, type, name, description, isLookup, isPrimary } = field;
      const customTheme = getColumnThemeByField({
        field,
        theme,
        sortFieldIds,
        groupFieldIds,
        filterFieldIds,
      });

      return {
        id,
        name,
        width,
        description,
        customTheme,
        isPrimary,
        hasMenu,
        icon: iconString(type, isLookup),
      };
    })
    .filter(Boolean)
    .filter((field) => {
      if (field) {
        return !view?.columnMeta?.[field?.id]?.hidden;
      }
      return false;
    }) as (IGridColumn & {
    id: string;
  })[];
};

export const createCellValue2GridDisplay =
  (fields: IFieldInstance[], editable: boolean) =>
  // eslint-disable-next-line sonarjs/cognitive-complexity
  (record: Record, col: number): ICell => {
    const field = fields[col];

    if (field == null) return { type: CellType.Loading };

    const { id: fieldId, type, isComputed, isMultipleCellValue: isMultiple, cellValueType } = field;

    let cellValue = record.getCellValue(fieldId);
    const validateCellValue = field.validateCellValue(cellValue);
    cellValue = validateCellValue.success ? validateCellValue.data : undefined;

    const readonly = isComputed || !editable;
    const cellId = `${record.id}-${fieldId}`;
    const baseCellProps = { id: cellId, readonly };

    switch (type) {
      case FieldType.SingleLineText: {
        const { showAs } = field.options;

        if (showAs != null) {
          const { type } = showAs;

          return {
            ...baseCellProps,
            type: CellType.Link,
            data: cellValue ? (Array.isArray(cellValue) ? cellValue : [cellValue]) : [],
            displayData: field.cellValue2String(cellValue),
            onClick: (text) => onMixedTextClick(type, text),
          };
        }

        return {
          ...baseCellProps,
          type: CellType.Text,
          data: (cellValue as string) || '',
          displayData: field.cellValue2String(cellValue),
        };
      }
      case FieldType.LongText: {
        return {
          ...baseCellProps,
          type: CellType.Text,
          data: (cellValue as string) || '',
          displayData: field.cellValue2String(cellValue),
          isWrap: true,
        };
      }
      case FieldType.Date:
      case FieldType.CreatedTime:
      case FieldType.LastModifiedTime: {
        let displayData = '';
        const { date, time, timeZone } = field.options.formatting;
        const cacheKey = `${fieldId}-${cellValue}-${date}-${time}-${timeZone}`;

        if (cellValueStringCache.has(cacheKey)) {
          displayData = cellValueStringCache.get(cacheKey) || '';
        } else {
          displayData = field.cellValue2String(cellValue);
          cellValueStringCache.set(cacheKey, displayData);
        }
        if (type === FieldType.CreatedTime || type === FieldType.LastModifiedTime) {
          return {
            ...baseCellProps,
            type: CellType.Text,
            data: (cellValue as string) || '',
            displayData,
          };
        }
        return {
          ...baseCellProps,
          type: CellType.Text,
          data: (cellValue as string) || '',
          displayData,
          customEditor: (props, editorRef) => (
            <GridDateEditor ref={editorRef} field={field} record={record} {...props} />
          ),
        };
      }
      case FieldType.AutoNumber: {
        return {
          ...baseCellProps,
          type: CellType.Number,
          data: cellValue as number,
          displayData: field.cellValue2String(cellValue),
        };
      }
      case FieldType.Number:
      case FieldType.Rollup:
      case FieldType.Formula: {
        if (cellValueType === CellValueType.Boolean) {
          return {
            ...baseCellProps,
            type: CellType.Boolean,
            data: (cellValue as boolean) || false,
            isMultiple,
          };
        }

        if (cellValueType === CellValueType.DateTime) {
          return {
            ...baseCellProps,
            type: CellType.Text,
            data: (cellValue as string) || '',
            displayData: field.cellValue2String(cellValue),
          };
        }

        if (cellValueType === CellValueType.String) {
          const showAs = field.options.showAs as ISingleLineTextShowAs;

          if (showAs != null) {
            const { type } = showAs;

            return {
              ...baseCellProps,
              type: CellType.Link,
              data: cellValue ? (Array.isArray(cellValue) ? cellValue : [cellValue]) : [],
              displayData: field.cellValue2String(cellValue),
              onClick: (text) => onMixedTextClick(type, text),
            };
          }

          return {
            ...baseCellProps,
            type: CellType.Text,
            data: (cellValue as string) || '',
            displayData: field.cellValue2String(cellValue),
          };
        }

        const optionShowAs = field.options.showAs as INumberShowAs;
        const showAs =
          optionShowAs == null
            ? undefined
            : {
                ...optionShowAs,
                color: ColorUtils.getHexForColor(optionShowAs.color),
              };

        if (showAs && isMultiple && Array.isArray(cellValue)) {
          return {
            ...baseCellProps,
            type: CellType.Chart,
            data: cellValue as number[],
            displayData: cellValue.map((v) => field.item2String(v)),
            chartType: showAs.type as unknown as ChartType,
            color: showAs.color,
          };
        }

        return {
          ...baseCellProps,
          type: CellType.Number,
          data: cellValue as number,
          displayData:
            isMultiple && Array.isArray(cellValue)
              ? cellValue.map((v) => field.item2String(v))
              : field.cellValue2String(cellValue),
          showAs: showAs as unknown as IGridNumberShowAs,
          customEditor: (props, editorRef) => (
            <GridNumberEditor
              ref={editorRef}
              field={field as NumberField}
              record={record}
              {...props}
            />
          ),
        };
      }
      case FieldType.MultipleSelect:
      case FieldType.SingleSelect: {
        const data = cellValue ? (Array.isArray(cellValue) ? cellValue : [cellValue]) : [];
        const choices = field.options.choices.map(({ name, color }) => {
          return {
            name,
            bgColor: ColorUtils.getHexForColor(color),
            textColor: ColorUtils.shouldUseLightTextOnColor(color) ? '#FFFFFF' : '#000000',
          };
        });
        return {
          ...baseCellProps,
          type: CellType.Select,
          data,
          displayData: data,
          choices,
          isMultiple,
          customEditor: (props, editorRef) => (
            <GridSelectEditor ref={editorRef} field={field} record={record} {...props} />
          ),
        };
      }
      case FieldType.Link: {
        const cv = cellValue ? (Array.isArray(cellValue) ? cellValue : [cellValue]) : [];
        const displayData = cv.map(({ title }) => title || 'Untitled');
        const choices = cv.map(({ id, title }) => ({ id, name: title }));
        return {
          ...baseCellProps,
          type: CellType.Select,
          data: cv,
          displayData,
          choices,
          isMultiple,
          customEditor: (props) => <GridLinkEditor field={field} record={record} {...props} />,
        };
      }
      case FieldType.Attachment: {
        const cv = (cellValue ?? []) as IAttachmentCellValue;
        const data = cv.map(({ id, mimetype, presignedUrl }) => ({
          id,
          url: getFileCover(mimetype, presignedUrl),
        }));
        const displayData = data.map(({ url }) => url);
        return {
          ...baseCellProps,
          type: CellType.Image,
          data,
          displayData,
          customEditor: (props) => (
            <GridAttachmentEditor field={field} record={record} {...props} />
          ),
        };
      }
      case FieldType.Checkbox: {
        return {
          ...baseCellProps,
          type: CellType.Boolean,
          data: (cellValue as boolean) || false,
          isMultiple,
        };
      }
      case FieldType.Rating: {
        const { icon, color, max } = field.options;

        if (isMultiple) {
          return {
            ...baseCellProps,
            type: CellType.Number,
            data: cellValue as number,
            displayData: field.cellValue2String(cellValue),
          };
        }

        return {
          ...baseCellProps,
          type: CellType.Rating,
          data: (cellValue as number) || 0,
          icon,
          color: ColorUtils.getHexForColor(color),
          max,
        };
      }
      case FieldType.User: {
        const cv = cellValue ? (Array.isArray(cellValue) ? cellValue : [cellValue]) : [];
        const data = cv.map(({ id, title }) => ({ id, name: title }));

        return {
          ...baseCellProps,
          type: CellType.User,
          data: data,
          customEditor: (props) => <GridUserEditor field={field} record={record} {...props} />,
        };
      }
      default: {
        return { type: CellType.Loading };
      }
    }
  };

export function useGridColumns(hasMenu?: boolean) {
  const view = useView();
  const fields = useFields();
  const totalFields = useFields({ withHidden: true });
  const permission = useTablePermission();
  const { theme } = useTheme();
  const editable = permission['record|update'];
  const sort = view?.sort;
  const group = view?.group;
  const filter = view?.filter;
  const isAutoSort = sort && !sort?.manualSort;

  const sortFieldIds = useMemo(() => {
    if (!isAutoSort) return;

    return sort.sortObjs.reduce((prev, item) => {
      prev.add(item.fieldId);
      return prev;
    }, new Set<string>());
  }, [sort, isAutoSort]);

  const groupFieldIds = useMemo(() => {
    if (!group?.length) return;

    return group.reduce((prev, item) => {
      prev.add(item.fieldId);
      return prev;
    }, new Set<string>());
  }, [group]);

  const filterFieldIds = useMemo(() => {
    if (filter == null) return;
    return getFilterFieldIds(filter?.filterSet, keyBy(totalFields, 'id'));
  }, [filter, totalFields]);

  return useMemo(
    () => ({
      columns: generateColumns({
        fields,
        view,
        theme,
        hasMenu,
        sortFieldIds,
        groupFieldIds,
        filterFieldIds,
      }),
      cellValue2GridDisplay: createCellValue2GridDisplay(fields, editable),
    }),
    [fields, view, hasMenu, editable, theme, sortFieldIds, groupFieldIds, filterFieldIds]
  );
}
