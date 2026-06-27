import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import PlatformBadge from '@/components/ui/PlatformBadge';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export default function ScheduleScreen() {
  const router = useRouter();
  const { videos } = useVideos();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const scheduled = videos.filter(v => v.status === 'scheduled');

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const totalCells = firstDay + daysInMonth;
  const rows = Math.ceil(totalCells / 7);

  const scheduledDays = new Set(
    scheduled
      .filter(v => v.scheduledAt)
      .map(v => {
        const d = new Date(v.scheduledAt!);
        if (d.getFullYear() === year && d.getMonth() === month) return d.getDate();
        return null;
      })
      .filter(Boolean) as number[]
  );

  const selectedVideos = selectedDay
    ? scheduled.filter(v => {
        if (!v.scheduledAt) return false;
        const d = new Date(v.scheduledAt);
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === selectedDay;
      })
    : scheduled;

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
    setSelectedDay(null);
  };

  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
    setSelectedDay(null);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Schedule</Text>

        {/* Calendar */}
        <View style={styles.calendarCard}>
          {/* Month nav */}
          <View style={styles.calMonth}>
            <Pressable onPress={prevMonth} hitSlop={12}>
              <MaterialIcons name="chevron-left" size={24} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.calMonthLabel}>{MONTHS[month]} {year}</Text>
            <Pressable onPress={nextMonth} hitSlop={12}>
              <MaterialIcons name="chevron-right" size={24} color={Colors.textSecondary} />
            </Pressable>
          </View>

          {/* Day headers */}
          <View style={styles.calDaysRow}>
            {DAYS.map(d => (
              <Text key={d} style={styles.calDayHeader}>{d}</Text>
            ))}
          </View>

          {/* Grid */}
          <View style={styles.calGrid}>
            {Array.from({ length: rows * 7 }).map((_, idx) => {
              const dayNum = idx - firstDay + 1;
              const isValid = dayNum >= 1 && dayNum <= daysInMonth;
              const isToday = isValid && dayNum === now.getDate() && month === now.getMonth() && year === now.getFullYear();
              const hasEvent = isValid && scheduledDays.has(dayNum);
              const isSelected = selectedDay === dayNum && isValid;

              return (
                <Pressable
                  key={idx}
                  style={[
                    styles.calCell,
                    isSelected && styles.calCellSelected,
                    isToday && !isSelected && styles.calCellToday,
                  ]}
                  onPress={() => isValid && setSelectedDay(isSelected ? null : dayNum)}
                  disabled={!isValid}
                >
                  <Text style={[
                    styles.calCellText,
                    !isValid && styles.calCellEmpty,
                    isToday && styles.calCellTodayText,
                    isSelected && styles.calCellSelectedText,
                  ]}>
                    {isValid ? dayNum : ''}
                  </Text>
                  {hasEvent ? (
                    <View style={[styles.eventDot, isSelected && { backgroundColor: '#fff' }]} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Scheduled Videos */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {selectedDay ? `${MONTHS[month]} ${selectedDay}` : 'Upcoming Posts'}
            {' '}
            <Text style={styles.sectionCount}>({selectedVideos.length})</Text>
          </Text>

          {selectedVideos.length > 0 ? selectedVideos.map(v => (
            <Pressable
              key={v.id}
              style={({ pressed }) => [styles.videoRow, pressed && { opacity: 0.8 }]}
              onPress={() => router.push({ pathname: '/editor', params: { id: v.id } })}
            >
              <Image source={{ uri: v.thumbnail }} style={styles.videoThumb} contentFit="cover" transition={200} />
              <View style={styles.videoInfo}>
                <Text style={styles.videoTitle} numberOfLines={1}>{v.title}</Text>
                <View style={styles.videoMeta}>
                  <MaterialIcons name="schedule" size={11} color={Colors.amber} />
                  <Text style={styles.videoDate}>
                    {v.scheduledAt ? new Date(v.scheduledAt).toLocaleDateString('en', {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    }) : ''}
                  </Text>
                </View>
                <View style={styles.platforms}>
                  {v.platforms.map(p => <PlatformBadge key={p} platform={p} size="sm" />)}
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={20} color={Colors.textMuted} />
            </Pressable>
          )) : (
            <View style={styles.empty}>
              <MaterialIcons name="event-busy" size={44} color={Colors.textMuted} />
              <Text style={styles.emptyText}>
                {selectedDay ? 'Nothing scheduled this day' : 'No upcoming posts'}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.8 }]}
                onPress={() => router.push('/upload')}
              >
                <Text style={styles.emptyBtnText}>Upload & Schedule</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    marginBottom: Spacing.md,
    includeFontPadding: false,
  },
  calendarCard: {
    marginHorizontal: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    marginBottom: Spacing.lg,
  },
  calMonth: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  calMonthLabel: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  calDaysRow: {
    flexDirection: 'row',
    marginBottom: Spacing.sm,
  },
  calDayHeader: {
    flex: 1,
    textAlign: 'center',
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  calGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
    position: 'relative',
  },
  calCellSelected: {
    backgroundColor: Colors.primary,
  },
  calCellToday: {
    backgroundColor: Colors.primary + '22',
  },
  calCellText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  calCellEmpty: { color: 'transparent' },
  calCellTodayText: { color: Colors.primaryLight, fontWeight: FontWeight.bold },
  calCellSelectedText: { color: '#fff', fontWeight: FontWeight.bold },
  eventDot: {
    position: 'absolute',
    bottom: 4,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.primaryLight,
  },
  section: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  sectionTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  sectionCount: {
    color: Colors.textMuted,
    fontWeight: FontWeight.regular,
  },
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  videoThumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
  },
  videoInfo: { flex: 1, gap: 4 },
  videoTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  videoMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  videoDate: {
    fontSize: FontSize.xs,
    color: Colors.amber,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
  platforms: {
    flexDirection: 'row',
    gap: 3,
  },
  empty: {
    alignItems: 'center',
    padding: Spacing.xl,
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  emptyBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: Radius.full,
    marginTop: 4,
  },
  emptyBtnText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
});
