import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { CreateUserForm } from "@/components/CreateUserForm";
import { UserRow } from "@/components/UserRow";

export default async function UsersPage() {
  const actor = await getActor();
  if (!hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN")) {
    return (
      <div className="card">
        <div className="empty-state">User management requires an admin role.</div>
      </div>
    );
  }

  const users = await withTenant(
    actor!.org_id,
    sql`SELECT id, employee_id, full_name, email, department, role, employment_status
        FROM app_user
        WHERE org_id = ${actor!.org_id}::uuid
        ORDER BY full_name`,
  );

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Invite a user</h3>
          <span className="hint">No email provider configured — the temp password is shown once</span>
        </div>
        <CreateUserForm viewerRole={actor!.role} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Organization members</h3>
          <span className="hint">{users.length} user(s)</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.id as string}
                user={
                  u as {
                    id: string;
                    employee_id: string;
                    full_name: string;
                    email: string;
                    department: string | null;
                    role: "EMPLOYEE" | "MANAGER" | "ASSET_ADMIN" | "SUPER_ADMIN";
                    employment_status: "ACTIVE" | "TERMINATED";
                  }
                }
                isSelf={u.id === actor!.id}
                viewerRole={actor!.role}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
