export interface NotificationPreviewUser {
  userId: number;
  userName: string;
  departmentName?: string;
  isActive: boolean;
}

export interface NotificationPreviewView {
  resolvedAt: string;
  totalCount: number;
  users: NotificationPreviewUser[];
}

export function countActiveRecipients(users: NotificationPreviewUser[]): number {
  return users.filter((user) => user.isActive).length;
}
