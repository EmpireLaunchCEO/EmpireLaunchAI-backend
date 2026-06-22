import { execSync } from 'child_process';

export class TeamDbClient {
  async execute(sql: string): Promise<any> {
    try {
      const output = execSync(`team-db "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
      return JSON.parse(output);
    } catch (error: any) {
      console.error('team-db execution failed:', error.message);
      throw error;
    }
  }

  async select(sql: string): Promise<any[]> {
    return this.execute(sql);
  }

  async insert(table: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = keys.map(k => {
      const v = data[k];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
      if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
      return v;
    });
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${values.join(', ')})`;
    return this.execute(sql);
  }

  async update(table: string, data: Record<string, any>, where: string) {
    const sets = Object.keys(data).map(k => {
      const v = data[k];
      let val = v;
      if (v === null || v === undefined) val = 'NULL';
      else if (typeof v === 'string') val = `'${v.replace(/'/g, "''")}'`;
      else if (typeof v === 'object') val = `'${JSON.stringify(v).replace(/'/g, "''")}'`;
      return `${k} = ${val}`;
    });
    const sql = `UPDATE ${table} SET ${sets.join(', ')}, updated_at = datetime('now') WHERE ${where}`;
    return this.execute(sql);
  }
}

export const teamDb = new TeamDbClient();
