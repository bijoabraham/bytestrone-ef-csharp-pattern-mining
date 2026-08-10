using System;
using System.Data.Entity;
using System.Data.Entity.Core.Objects;
using System.Data.Entity.ModelConfiguration;
using System.Data.Entity.Infrastructure.Interception;

namespace Sample
{
    public class MyContext : ObjectContext { } // ef_objectcontext_usages
    
    public class LegacyDb : DbContext // ef_dbcontext_usages
    {
        public IDbSet<string> Users { get; set; } // ef_idbset_usages
        public DbSet<int> Orders { get; set; } // ef_dbset_usages
        public virtual string NavProp { get; set; } // ef_virtual_nav_props
        
        public void Init()
        {
            Database.SetInitializer<LegacyDb>(null); // ef_set_initializer_usages
            Database.ExecuteSqlCommand("SELECT 1"); // ef_execute_sql_command_usages
            Database.SqlQuery<int>("SELECT 1"); // ef_execute_sql_query_usages
            DbInterception.Add(new object()); // ef_db_interception_usages
        }
    }
    
    public class UserConfig : EntityTypeConfiguration<string> { } // ef_entity_type_configuration_usages
    public class MyDbConfig : DbConfiguration { } // ef_dbconfiguration_usages
}
